package files

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hostherd/agent/internal/model"
)

func TestImageReadPreservesCompletePNGAndJPEG(t *testing.T) {
	im := image.NewNRGBA(image.Rect(0, 0, 800, 600))
	rand.New(rand.NewSource(1)).Read(im.Pix)
	for _, format := range []string{"png", "jpeg"} {
		t.Run(format, func(t *testing.T) {
			var original bytes.Buffer
			var err error
			if format == "png" {
				err = png.Encode(&original, im)
			} else {
				err = jpeg.Encode(&original, im, nil)
			}
			if err != nil {
				t.Fatal(err)
			}
			if format == "png" && original.Len() <= maxReadLimit {
				t.Fatal("fixture must exceed the ordinary file.read page limit")
			}
			// Detect content even when the extension is absent or incorrect.
			path := filepath.Join(t.TempDir(), "capture.txt")
			writeFixture(t, path, original.Bytes(), 0600)
			result := call(t, "file.image", map[string]any{"path": path}).(ImageResult)
			decoded, err := base64.StdEncoding.DecodeString(result.Data)
			if err != nil || !bytes.Equal(decoded, original.Bytes()) {
				t.Fatal("image response did not preserve all original bytes", err)
			}
			if result.MimeType != "image/"+format || result.Size != original.Len() || result.Width != 800 || result.Height != 600 {
				t.Fatalf("incorrect image metadata: mime=%s size=%d dimensions=%dx%d", result.MimeType, result.Size, result.Width, result.Height)
			}
			assertFile(t, path, original.Bytes())
		})
	}
}

func TestImageReadRejectsInvalidInputsWithCorrectiveErrors(t *testing.T) {
	root := t.TempDir()
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	truncated := filepath.Join(root, "truncated.png")
	writeFixture(t, truncated, pngBytes.Bytes()[:33], 0600)
	text := filepath.Join(root, "text.png")
	writeFixture(t, text, []byte("not an image"), 0600)
	oversized := filepath.Join(root, "large.png")
	writeFixture(t, oversized, nil, 0600)
	if err := os.Truncate(oversized, maxImageBytes+1); err != nil {
		t.Fatal(err)
	}
	largePixels := append([]byte(nil), pngBytes.Bytes()...)
	binary.BigEndian.PutUint32(largePixels[16:20], 10000)
	binary.BigEndian.PutUint32(largePixels[20:24], 10000)
	binary.BigEndian.PutUint32(largePixels[29:33], crc32.ChecksumIEEE(largePixels[12:29]))
	huge := filepath.Join(root, "huge.png")
	writeFixture(t, huge, largePixels, 0600)
	for _, test := range []struct{ path, code, hint string }{
		{"relative.png", "INVALID_IMAGE_PATH", "absolute"},
		{"https://example.com/screenshot.png", "INVALID_IMAGE_PATH", "URLs"},
		{root, "INVALID_IMAGE_PATH", "regular image file"},
		{filepath.Join(root, "missing.png"), "IMAGE_NOT_FOUND", "same server"},
		{text, "INVALID_IMAGE", "PNG/JPEG"},
		{truncated, "INVALID_IMAGE", "incomplete or corrupt"},
		{oversized, "IMAGE_TOO_LARGE", "smaller JPEG"},
		{huge, "IMAGE_TOO_LARGE", "24 million pixels"},
	} {
		t.Run(test.path, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]string{"path": test.path})
			result, err := Handle("file.image", raw)
			var rpcError *model.RPCError
			if result != nil || !errors.As(err, &rpcError) || rpcError.Code != test.code || !strings.Contains(err.Error(), test.hint) {
				t.Fatalf("expected %s with corrective hint, got result=%v error=%v", test.code, result, err)
			}
		})
	}
}
