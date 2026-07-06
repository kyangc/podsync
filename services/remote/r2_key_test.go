package remote

import (
	"strings"
	"testing"
	"unicode"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestBuildR2KeyUsesPrefixAndSanitizedSegments(t *testing.T) {
	task := &model.RemotePublishTask{
		FeedID:         "feed/one",
		LocalEpisodeID: "BV:1",
		MediaPath:      "feed/ep.mp3",
	}

	key := BuildR2Key("audio", task, "abc")

	assert.Equal(t, "audio/feed_one/BV_1-abc.mp3", key)
}

func TestBuildR2KeyDefaultsPrefixAndExtension(t *testing.T) {
	task := &model.RemotePublishTask{
		FeedID:         "feed",
		LocalEpisodeID: "episode",
		MediaPath:      "feed/episode",
	}

	key := BuildR2Key("", task, "abc")

	assert.Equal(t, "audio/feed/episode-abc.bin", key)
}

func TestBuildR2KeyDoesNotMutateEpisodeIdentity(t *testing.T) {
	task := &model.RemotePublishTask{
		FeedID:         "feed/one",
		LocalEpisodeID: "BV:1/part",
		MediaPath:      "feed/episode.m4a",
	}

	key := BuildR2Key("podcasts/audio", task, "abc")

	assert.Equal(t, "podcasts/audio/feed_one/BV_1_part-abc.m4a", key)
	assert.Equal(t, "BV:1/part", task.LocalEpisodeID)
}

func TestBuildR2KeyFallsBackEmptySegments(t *testing.T) {
	task := &model.RemotePublishTask{
		FeedID:         "///",
		LocalEpisodeID: "::",
		MediaPath:      "feed/episode.mp3",
	}

	key := BuildR2Key("///", task, "abc")

	assert.Equal(t, "audio/feed/episode-abc.mp3", key)
}

func TestNewAssetTokenReturnsURLSafeToken(t *testing.T) {
	token, err := NewAssetToken()

	require.NoError(t, err)
	require.NotEmpty(t, token)
	for _, r := range token {
		assert.True(t, unicode.IsDigit(r) || (r >= 'a' && r <= 'z'), "unexpected token char %q in %q", r, token)
	}
	assert.Equal(t, strings.ToLower(token), token)
}
