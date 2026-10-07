package files

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	defaultSearchLimit = 100
	maxSearchLimit     = 1000
	searchPreviewBytes = 512
	searchResponseMax  = 1024 * 1024
	searchBufferBytes  = 64 * 1024
	binaryProbeBytes   = 8 * 1024
)

type SearchMatch struct {
	Path string `json:"path"`
	Line int64  `json:"line"`
	// Text is a prefix preview, not the complete line. Truncated is true when
	// the line is longer. Literal matching still considers the entire line.
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

type SearchResult struct {
	Matches    []SearchMatch `json:"matches"`
	NextOffset int64         `json:"nextOffset"`
	EOF        bool          `json:"eof"`
}

var errSearchPageFull = errors.New("search page full")

func search(raw json.RawMessage) (any, error) {
	var p struct {
		Path   string `json:"path"`
		Query  string `json:"query"`
		Offset int64  `json:"offset"`
		Limit  *int64 `json:"limit"`
	}
	if err := decode(raw, &p); err != nil {
		return nil, err
	}
	if err := validatePath(p.Path); err != nil {
		return nil, err
	}
	if p.Query == "" || strings.ContainsAny(p.Query, "\n\x00") {
		return nil, errors.New("query must be non-empty literal text on one line without NUL bytes")
	}
	if p.Offset < 0 || (p.Limit != nil && *p.Limit < 0) {
		return nil, errors.New("offset and limit must not be negative")
	}
	limit := int64(defaultSearchLimit)
	if p.Limit != nil && *p.Limit > 0 {
		limit = min(*p.Limit, int64(maxSearchLimit))
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	result := SearchResult{Matches: []SearchMatch{}, NextOffset: p.Offset, EOF: true}
	seen := int64(0)
	responseBytes := 256 // Covers array separators and response metadata.
	matcher := newLiteralMatcher([]byte(p.Query))
	add := func(path string, line int64, text string, truncated bool) error {
		if seen < p.Offset {
			seen++
			return nil
		}
		match := SearchMatch{Path: path, Line: line, Text: text, Truncated: truncated}
		encoded, err := json.Marshal(match)
		if err != nil {
			return err
		}
		if int64(len(result.Matches)) >= limit || responseBytes+len(encoded)+1 > searchResponseMax {
			result.EOF = false
			return errSearchPageFull
		}
		result.Matches = append(result.Matches, match)
		result.NextOffset++
		responseBytes += len(encoded) + 1
		return nil
	}
	visit := func(path string) error {
		return searchFile(path, matcher, func(line int64, text string, truncated bool) error {
			return add(path, line, text, truncated)
		})
	}
	if !info.IsDir() {
		err = visit(p.Path)
	} else {
		// Follow an explicitly supplied root symlink, but never recurse into
		// directory symlinks encountered below it. WalkDir visits entries in
		// lexical order without loading the entire tree into memory.
		root, resolveErr := filepath.EvalSymlinks(p.Path)
		if resolveErr != nil {
			return nil, resolveErr
		}
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			return visit(filepath.Join(p.Path, relative))
		})
	}
	if err != nil && !errors.Is(err, errSearchPageFull) {
		return nil, err
	}
	return result, nil
}

// searchFile keeps a bounded prefix and matcher state even for lines with no
// newline across many megabytes. No Scanner token limit or full-line allocation
// is used. Each matching line contributes one result, regardless of occurrences.
func searchFile(path string, matcher *literalMatcher, add func(int64, string, bool) error) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil // Includes directory symlinks, pipes, devices and sockets.
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, searchBufferBytes)
	probe, err := reader.Peek(binaryProbeBytes)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return nil
	}
	preview := make([]byte, 0, searchPreviewBytes)
	line, length := int64(1), int64(0)
	matched := false
	matcher.reset()
	finishLine := func() error {
		if !matched {
			return nil
		}
		truncated := length > int64(len(preview))
		if truncated {
			// Do not split a UTF-8 rune at the preview boundary.
			start := len(preview) - 1
			for start > 0 && !utf8.RuneStart(preview[start]) {
				start--
			}
			if start >= 0 && !utf8.FullRune(preview[start:]) {
				preview = preview[:start]
			}
		}
		text := strings.ToValidUTF8(string(preview), "�")
		if !truncated {
			text = strings.TrimSuffix(text, "\r")
		}
		return add(line, text, truncated)
	}
	for {
		fragment, readErr := reader.ReadSlice('\n')
		hasNewline := len(fragment) > 0 && fragment[len(fragment)-1] == '\n'
		if hasNewline {
			fragment = fragment[:len(fragment)-1]
		}
		length += int64(len(fragment))
		if available := searchPreviewBytes - len(preview); available > 0 {
			preview = append(preview, fragment[:min(len(fragment), available)]...)
		}
		if !matched {
			matched = matcher.feed(fragment)
		}
		if hasNewline || errors.Is(readErr, io.EOF) {
			if err := finishLine(); err != nil {
				return err
			}
			line++
			length = 0
			matched = false
			preview = preview[:0]
			matcher.reset()
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil && !errors.Is(readErr, bufio.ErrBufferFull) {
			return readErr
		}
	}
}

// KMP keeps matching work linear and carries partial matches across chunks.
type literalMatcher struct {
	query []byte
	table []int
	state int
}

func newLiteralMatcher(query []byte) *literalMatcher {
	m := &literalMatcher{query: query, table: make([]int, len(query))}
	for i, prefix := 1, 0; i < len(query); i++ {
		for prefix > 0 && query[i] != query[prefix] {
			prefix = m.table[prefix-1]
		}
		if query[i] == query[prefix] {
			prefix++
		}
		m.table[i] = prefix
	}
	return m
}

func (m *literalMatcher) reset() { m.state = 0 }

func (m *literalMatcher) feed(data []byte) bool {
	for _, c := range data {
		for m.state > 0 && c != m.query[m.state] {
			m.state = m.table[m.state-1]
		}
		if c == m.query[m.state] {
			m.state++
		}
		if m.state == len(m.query) {
			m.state = m.table[m.state-1]
			return true
		}
	}
	return false
}
