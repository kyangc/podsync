package remote

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLocalMediaStoreOpenReadsRelativeFile(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "feed"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "feed", "episode.mp3"), []byte("audio"), 0644))

	reader, err := (LocalMediaStore{Root: root}).Open("feed/episode.mp3")
	require.NoError(t, err)
	defer reader.Close()

	got, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, []byte("audio"), got)
}

func TestLocalMediaStoreRejectsEscapingPath(t *testing.T) {
	store := LocalMediaStore{Root: t.TempDir()}
	tests := []string{
		"/abs",
		"../x",
		"a/../../x",
	}

	for _, name := range tests {
		t.Run(name, func(t *testing.T) {
			reader, err := store.Open(name)

			require.Error(t, err)
			assert.Nil(t, reader)
			assert.True(t, errors.Is(err, ErrUnsafeMediaPath))
		})
	}
}
