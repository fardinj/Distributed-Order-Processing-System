#!/bin/sh
set -eu
umask 077
printf 'include /usr/local/etc/redis/redis.conf\nrequirepass %s\n' "$(cat /run/secrets/redis_password)" > /tmp/redis-runtime.conf
chown redis:redis /tmp/redis-runtime.conf
exec /usr/local/bin/docker-entrypoint.sh redis-server /tmp/redis-runtime.conf
