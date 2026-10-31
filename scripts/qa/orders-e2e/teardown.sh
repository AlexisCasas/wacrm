#!/usr/bin/env bash
# Removes the QA containers and network. Touches nothing else.
docker rm -f qa-edge-on qa-edge-off qa-proxy qa-rest-inka qa-rest-wacrm qa-pg 2>/dev/null
docker network rm qa-net 2>/dev/null
exit 0
