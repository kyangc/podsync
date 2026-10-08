//go:build unix

package ytdl

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCommandCleansUpChildrenAfterLeaderExits(t *testing.T) {
	for _, exitCode := range []int{0, 1} {
		t.Run(strconv.Itoa(exitCode), func(t *testing.T) { assertLeaderChildrenCleaned(t, exitCode) })
	}
}

func assertLeaderChildrenCleaned(t *testing.T, exitCode int) {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	t.Setenv("PODSYNC_TEST_CHILD_PID", pidFile)
	dl := commandFixture(t, `sleep 30 &
printf '%s' "$!" > "$PODSYNC_TEST_CHILD_PID"
exit `+strconv.Itoa(exitCode)+"\n")
	dl.timeout = 10 * time.Second
	started := time.Now()
	_, err := dl.exec(context.Background())
	if exitCode == 0 {
		require.ErrorIs(t, err, exec.ErrWaitDelay)
	} else {
		var exitError *exec.ExitError
		require.ErrorAs(t, err, &exitError)
		assert.Equal(t, exitCode, exitError.ExitCode())
	}
	assert.Less(t, time.Since(started), 5*time.Second)
	data, err := os.ReadFile(pidFile)
	require.NoError(t, err)
	pid, err := strconv.Atoi(string(data))
	require.NoError(t, err)
	childAlive := true
	t.Cleanup(func() {
		if childAlive {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	require.Eventually(t, func() bool {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			childAlive = false
			return true
		}
		// A killed orphan may remain a zombie until its new parent reaps it.
		output, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
		childAlive = err != nil || !strings.HasPrefix(strings.TrimSpace(string(output)), "Z")
		return !childAlive
	}, time.Second, 10*time.Millisecond, "child process survived pipe wait expiration")
}
