#!/bin/sh

socat TCP-LISTEN:11434,fork TCP:laama-svc:11434 &
SOCAT_PID=$!

node server.js

wait $SOCAT_PID
