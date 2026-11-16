#!/bin/sh
# Archived upstream is used only as an isolated protocol fixture, not a production recommendation.
set -eu
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo 'Approved GitHub-hosted runner required' >&2; exit 1; }
: "${RUNNER_TEMP:?Owned runner scratch directory required}"
COMMIT=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e
ROOT=$(mktemp -d "$RUNNER_TEMP/feedink-s3-build.XXXXXXXX")
trap 'rm -rf "$ROOT"' EXIT
mkdir "$ROOT/source" "$ROOT/image"
git -C "$ROOT/source" init --quiet
git -C "$ROOT/source" remote add origin https://github.com/minio/minio.git
git -C "$ROOT/source" fetch --quiet --depth=1 origin "$COMMIT"
[ "$(git -C "$ROOT/source" rev-parse FETCH_HEAD)" = "$COMMIT" ]
git -C "$ROOT/source" checkout --quiet --detach FETCH_HEAD
(
  cd "$ROOT/source"
  CGO_ENABLED=0 go build -p 2 -trimpath -o "$ROOT/image/minio" .
)
cp -f "$ROOT/source/LICENSE" "$ROOT/image/LICENSE"
printf '%s\n' \
  'FROM alpine:3.22' \
  'RUN apk add --no-cache ca-certificates && mkdir /data && chown 65532:65532 /data' \
  'COPY --chmod=0555 minio /usr/local/bin/minio' \
  'COPY LICENSE /usr/share/licenses/minio/LICENSE' \
  'USER 65532:65532' \
  'ENV MINIO_UPDATE=off MINIO_BROWSER=off' \
  'ENTRYPOINT ["/usr/local/bin/minio"]' > "$ROOT/image/Dockerfile"
docker build --tag feedink-s3-fixture:ci "$ROOT/image"
