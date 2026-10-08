package ytdl

import (
	"context"
	"os/exec"
	"strconv"
)

func configureCommand(cmd *exec.Cmd) func() {
	cmd.Cancel = func() error {
		ctx, cancel := context.WithTimeout(context.Background(), commandWaitDelay)
		defer cancel()
		kill := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
		kill.WaitDelay = commandWaitDelay
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	return func() {}
}
