#!/bin/sh
# Tracker helper: tk.sh METHOD PATH [JSON_BODY]   (reads TRACKER_URL, TRACKER_TOKEN from env; never prints them)
m="$1"; p="$2"; b="$3"
if [ -n "$b" ]; then
  curl -s -X "$m" -H "authorization: Bearer $TRACKER_TOKEN" -H "content-type: application/json" -d "$b" "$TRACKER_URL$p"
else
  curl -s -X "$m" -H "authorization: Bearer $TRACKER_TOKEN" "$TRACKER_URL$p"
fi
