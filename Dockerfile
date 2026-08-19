ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM golang:1.25 AS builder

ARG TAG="nightly"
ARG COMMIT=""
ARG TARGETOS=linux
ARG TARGETARCH
ARG BGUTIL_POT_PROVIDER_VERSION="1.3.1"
ARG BGUTIL_POT_PROVIDER_SHA256="b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38"

ENV TAG="${TAG}"
ENV COMMIT="${COMMIT}"

WORKDIR /build

COPY . .

RUN targetarch="${TARGETARCH:-$(go env GOARCH)}" && \
    CGO_ENABLED=0 GOOS="${TARGETOS:-linux}" GOARCH="${targetarch}" make build && \
    test -s bin/podsync

# Download yt-dlp
RUN wget -O /usr/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod a+rwx /usr/bin/yt-dlp

# Download the opt-in yt-dlp PO Token provider plugin. It is deliberately kept
# outside yt-dlp's automatic plugin directories so deployments without the
# provider sidecar retain their existing behavior.
RUN mkdir -p /opt/podsync/yt-dlp-plugins && \
    wget -O /opt/podsync/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip \
      "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_POT_PROVIDER_VERSION}/bgutil-ytdlp-pot-provider.zip" && \
    echo "${BGUTIL_POT_PROVIDER_SHA256}  /opt/podsync/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip" | sha256sum -c -

# Alpine 3.24 will go EOL on 2028-05-01
FROM alpine:3.24

WORKDIR /app

# deno is required for yt-dlp (ref: https://github.com/yt-dlp/yt-dlp/issues/14404)
RUN apk --no-cache add ca-certificates python3 py3-pip ffmpeg tzdata libc6-compat deno

RUN chmod 777 /usr/local/bin
COPY --from=builder /usr/bin/yt-dlp /usr/local/bin/youtube-dl
COPY --from=builder /opt/podsync/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip /opt/podsync/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip
COPY --from=builder /build/bin/podsync /app/podsync
COPY --from=builder /build/html/index.html /app/html/index.html
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/podsync/THIRD_PARTY_NOTICES.md

ENTRYPOINT ["/app/podsync"]
CMD ["--no-banner"]
