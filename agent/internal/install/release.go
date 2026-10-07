package install

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// A release signs the exact decoded payload bytes, not a reserialized object.
// The public key is PKIX PEM and is pinned by the initial HTTPS installation.
type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type Manifest struct {
	Version   string              `json:"version"`
	Protocol  int                 `json:"protocol"`
	Artifacts map[string]Artifact `json:"artifacts"`
}

type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$`)
var shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func VerifyManifest(data []byte, publicKey string) (Manifest, error) {
	var manifest Manifest
	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return manifest, fmt.Errorf("release envelope: %w", err)
	}
	block, rest := pem.Decode([]byte(publicKey))
	if block == nil || block.Type != "PUBLIC KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return manifest, fmt.Errorf("release key must be a PKIX PUBLIC KEY PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return manifest, fmt.Errorf("release public key: %w", err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return manifest, fmt.Errorf("release key must be Ed25519")
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return manifest, fmt.Errorf("release payload encoding: %w", err)
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil || !ed25519.Verify(key, payload, signature) {
		return manifest, fmt.Errorf("release signature verification failed")
	}
	if err = json.Unmarshal(payload, &manifest); err != nil {
		return manifest, fmt.Errorf("release payload: %w", err)
	}
	if !versionPattern.MatchString(manifest.Version) {
		return manifest, fmt.Errorf("invalid release version")
	}
	if manifest.Protocol != 1 {
		return manifest, fmt.Errorf("unsupported runner protocol %d", manifest.Protocol)
	}
	for _, platform := range []string{"linux-amd64", "linux-arm64"} {
		if _, exists := manifest.Artifacts[platform]; !exists {
			return manifest, fmt.Errorf("missing %s artifact", platform)
		}
	}
	// Older Linux-only releases remain valid; validate every supplied platform.
	for platform, artifact := range manifest.Artifacts {
		if !shaPattern.MatchString(artifact.SHA256) {
			return manifest, fmt.Errorf("missing or invalid %s artifact", platform)
		}
		if err := validateHTTPS(artifact.URL); err != nil {
			return manifest, fmt.Errorf("%s artifact: %w", platform, err)
		}
	}
	return manifest, nil
}

var artifactName = regexp.MustCompile(`^hostherd-[a-z0-9]+-[a-z0-9]+(\.exe)?$`)

// ArtifactURL locates an artifact next to the manifest it is listed in. Only
// the file name of the signed URL is used, so one release works under any
// central address; the signed SHA-256 still pins the contents.
func ArtifactURL(manifestURL string, a Artifact) (string, error) {
	base, err := url.Parse(manifestURL)
	if err != nil {
		return "", err
	}
	signed, err := url.Parse(a.URL)
	if err != nil {
		return "", err
	}
	name := path.Base(signed.Path)
	if !artifactName.MatchString(name) {
		return "", fmt.Errorf("unexpected artifact name %q", name)
	}
	return base.ResolveReference(&url.URL{Path: name}).String(), nil
}

func validateHTTPS(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("an HTTPS URL without credentials or fragment is required")
	}
	return nil
}

// CompareVersions follows SemVer precedence. Build metadata is deliberately not
// accepted: an installed version names one immutable binary generation.
func CompareVersions(a, b string) (int, error) {
	aa, bb := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	if aa == nil || bb == nil {
		return 0, fmt.Errorf("invalid release version")
	}
	for i := 1; i <= 3; i++ {
		n, err := strconv.ParseUint(aa[i], 10, 64)
		if err != nil {
			return 0, err
		}
		m, err := strconv.ParseUint(bb[i], 10, 64)
		if err != nil {
			return 0, err
		}
		if n < m {
			return -1, nil
		}
		if n > m {
			return 1, nil
		}
	}
	if aa[4] == bb[4] {
		return 0, nil
	}
	if aa[4] == "" {
		return 1, nil
	}
	if bb[4] == "" {
		return -1, nil
	}
	ap, bp := strings.Split(aa[4], "."), strings.Split(bb[4], ".")
	for i := 0; i < len(ap) && i < len(bp); i++ {
		if ap[i] == bp[i] {
			continue
		}
		an, ae := strconv.ParseUint(ap[i], 10, 64)
		bn, be := strconv.ParseUint(bp[i], 10, 64)
		if ae == nil && be == nil {
			if an < bn {
				return -1, nil
			}
			return 1, nil
		}
		if ae == nil {
			return -1, nil
		}
		if be == nil {
			return 1, nil
		}
		if ap[i] < bp[i] {
			return -1, nil
		}
		return 1, nil
	}
	if len(ap) < len(bp) {
		return -1, nil
	}
	return 1, nil
}

func verifyReader(reader io.Reader, expected string, dest io.Writer) error {
	if !shaPattern.MatchString(expected) {
		return fmt.Errorf("invalid artifact SHA256")
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(hash, dest), reader); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		return fmt.Errorf("artifact SHA256 verification failed")
	}
	return nil
}
