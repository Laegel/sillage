#!/usr/bin/env bash
trap 'kill 0' EXIT
npm --prefix server run dev &
npm --prefix frontend run dev &
wait
