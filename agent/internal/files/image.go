package files

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"

	"hostherd/agent/internal/model"
)

// Bound whole-image responses and decoder memory, independently of job logs.
const maxImageBytes = 8 * 1024 * 1024
const maxImagePixels = 24_000_000

type ImageResult struct {
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
	Size     int    `json:"size"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

func imageFailure(code, path, message string) error {
	return &model.RPCError{Code: code, Message: fmt.Sprintf("Cannot read image path=%q: %s", path, message)}
}

func imageFileError(path string, err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return imageFailure("IMAGE_NOT_FOUND", path, "file not found. First save the screenshot/image and wait for the creating job to complete, then use its absolute file path on the same server.")
	}
	if errors.Is(err, os.ErrPermission) {
		return imageFailure("IMAGE_PERMISSION_DENIED", path, "the registered execution account cannot read this file. Save the image in a location readable by that account.")
	}
	return imageFailure("IMAGE_READ_FAILED", path, err.Error())
}

func readImage(raw json.RawMessage) (any, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, imageFailure("INVALID_IMAGE_PATH", p.Path, "use an absolute image FILE path on the target server, for example /tmp/screenshot.png; URLs, directories and base64 strings are not paths.")
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, imageFileError(p.Path, err)
	}
	if !info.Mode().IsRegular() {
		return nil, imageFailure("INVALID_IMAGE_PATH", p.Path, "expected a regular image file. Pass the saved PNG/JPEG file path, not a directory or special file.")
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return nil, imageFileError(p.Path, err)
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return nil, imageFileError(p.Path, err)
	}
	if !info.Mode().IsRegular() {
		return nil, imageFailure("INVALID_IMAGE_PATH", p.Path, "expected a regular image file.")
	}
	tooLarge := func() error {
		return imageFailure("IMAGE_TOO_LARGE", p.Path, "image exceeds 8 MiB or 24 million pixels. Save a resized/cropped image or a smaller JPEG, then read that file. No partial image was returned.")
	}
	if info.Size() > maxImageBytes {
		return nil, tooLarge()
	}
	data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
	if err != nil {
		return nil, imageFileError(p.Path, err)
	}
	if len(data) > maxImageBytes {
		return nil, tooLarge()
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, imageFailure("INVALID_IMAGE", p.Path, "file is not a readable PNG/JPEG image. Save or convert it to PNG/JPEG and wait until writing has completed; changing the filename extension is not sufficient.")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return nil, tooLarge()
	}
	// Decode the same bounded bytes to reject incomplete captures, not just headers.
	if _, _, err = image.Decode(bytes.NewReader(data)); err != nil {
		return nil, imageFailure("INVALID_IMAGE", p.Path, "PNG/JPEG data is incomplete or corrupt. Wait for the creating job to complete or capture the image again.")
	}
	mimeType := map[string]string{"png": "image/png", "jpeg": "image/jpeg"}[format]
	if mimeType == "" {
		return nil, imageFailure("INVALID_IMAGE", p.Path, "only PNG and JPEG images are supported. Convert the file to PNG/JPEG first.")
	}
	return ImageResult{Data: base64.StdEncoding.EncodeToString(data), MimeType: mimeType, Size: len(data), Width: config.Width, Height: config.Height}, nil
}
