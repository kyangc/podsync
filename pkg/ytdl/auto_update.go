package ytdl

import (
	"context"
	"time"

	log "github.com/sirupsen/logrus"
)

func (dl *YoutubeDl) autoUpdate(ctx context.Context, period time.Duration) {
	timer := time.NewTimer(period)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if ctx.Err() != nil {
			return
		}
		if err := dl.Update(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.WithError(err).Error("update failed")
		}
		timer.Reset(period)
	}
}
