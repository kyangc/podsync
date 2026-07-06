package remote

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}

var ErrUnsafeMediaPath = errors.New("media path escapes local storage root")

type LocalMediaStore struct {
	Root string
}

func (s LocalMediaStore) Open(name string) (ReadSeekCloser, error) {
	clean := filepath.Clean(name)
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return nil, ErrUnsafeMediaPath
	}
	return os.Open(filepath.Join(s.Root, clean))
}
