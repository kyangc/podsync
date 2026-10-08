//go:build !unix && !windows

package ytdl

import "os/exec"

func configureCommand(_ *exec.Cmd) func() { return func() {} }
