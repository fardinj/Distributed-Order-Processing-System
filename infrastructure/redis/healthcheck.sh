#!/bin/sh
set -eu
export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"
test "$(redis-cli ping)" = PONG
