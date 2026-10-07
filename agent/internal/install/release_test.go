package install

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"strings"
	"testing"
)

func signedFixture(t *testing.T, version string, binary []byte) ([]byte, string, Manifest) {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	hash := sha256.Sum256(binary)
	manifest := Manifest{Version: version, Protocol: 1, Artifacts: map[string]Artifact{}}
	for _, platform := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"} {
		manifest.Artifacts[platform] = Artifact{URL: "https://mcp.example/downloads/hostherd-" + platform, SHA256: hex.EncodeToString(hash[:])}
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(Envelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
	if err != nil {
		t.Fatal(err)
	}
	return envelope, key, manifest
}

func TestReleaseSignatureRejectsTamperingAndWrongKey(t *testing.T) {
	data, key, expected := signedFixture(t, "1.2.3", []byte("signed executable"))
	manifest, err := VerifyManifest(data, key)
	if err != nil || manifest.Version != expected.Version {
		t.Fatalf("valid signed release: %v", err)
	}
	var envelope Envelope
	if err = json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	payload, _ := base64.StdEncoding.DecodeString(envelope.Payload)
	payload = bytes.Replace(payload, []byte("1.2.3"), []byte("9.9.9"), 1)
	envelope.Payload = base64.StdEncoding.EncodeToString(payload)
	tampered, _ := json.Marshal(envelope)
	if _, err = VerifyManifest(tampered, key); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("tampered version accepted: %v", err)
	}
	_, wrongKey, _ := signedFixture(t, "1.2.3", nil)
	if _, err = VerifyManifest(data, wrongKey); err == nil {
		t.Fatal("release accepted under another key")
	}
	if _, err = VerifyManifest(data, "not a key"); err == nil {
		t.Fatal("invalid public key accepted")
	}
}

func TestArtifactIntegrity(t *testing.T) {
	binary := []byte("trusted bytes")
	_, _, manifest := signedFixture(t, "0.1.0", binary)
	digest := manifest.Artifacts["linux-amd64"].SHA256
	var out bytes.Buffer
	if err := verifyReader(bytes.NewReader(binary), digest, &out); err != nil || !bytes.Equal(binary, out.Bytes()) {
		t.Fatalf("copy: %v", err)
	}
	if err := verifyReader(strings.NewReader("tampered bytes"), digest, io.Discard); err == nil {
		t.Fatal("tampered binary accepted")
	}
}

func TestVersionOrdering(t *testing.T) {
	for _, pair := range [][2]string{{"0.1.0", "0.2.0"}, {"1.9.9", "1.10.0"}, {"2.0.0-rc.2", "2.0.0-rc.10"}, {"2.0.0-rc.10", "2.0.0"}, {"1.0.0-alpha", "1.0.0-alpha.1"}} {
		if n, err := CompareVersions(pair[0], pair[1]); err != nil || n >= 0 {
			t.Fatalf("order %v: %d %v", pair, n, err)
		}
		if n, err := CompareVersions(pair[1], pair[0]); err != nil || n <= 0 {
			t.Fatalf("reverse %v: %d %v", pair, n, err)
		}
	}
	if n, err := CompareVersions("0.1.0", "0.1.0"); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	for _, bad := range []string{"../../runner", "0.1", "v0.1.0", "1.2.03", "1.0.0\nExecStart=bad"} {
		if _, err := CompareVersions(bad, "1.0.0"); err == nil {
			t.Errorf("invalid version accepted: %q", bad)
		}
	}
}

func TestReleaseURLRequiresTLS(t *testing.T) {
	for _, raw := range []string{"http://example/x", "https://u:p@example/x", "file:///tmp/x", "https://example/x#bad"} {
		if validateHTTPS(raw) == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if err := validateHTTPS("https://example/downloads/a"); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactURLFollowsTheManifestLocation(t *testing.T) {
	got, err := ArtifactURL("https://gate.example/base/downloads/manifest.json", Artifact{URL: "https://build.invalid/downloads/hostherd-linux-amd64"})
	if err != nil || got != "https://gate.example/base/downloads/hostherd-linux-amd64" {
		t.Fatal(got, err)
	}
	for _, bad := range []string{"https://x/downloads/", "https://x/downloads/../../etc/passwd", "https://x/downloads/other"} {
		if got, err := ArtifactURL("https://gate.example/downloads/manifest.json", Artifact{URL: bad}); err == nil {
			t.Fatal("accepted", bad, got)
		}
	}
}
