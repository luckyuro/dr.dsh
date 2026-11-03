#!/bin/sh
# The certificate name can differ from the bind IP. Connect locally while still
# checking the certificate against its configured name by default.
set -eu
drdsh_addr=${DSH_RELAY_BIND:-0.0.0.0:8787}
drdsh_port=${drdsh_addr##*:}
drdsh_ip=${drdsh_addr%:*}
case "$drdsh_ip" in 0.0.0.0) drdsh_ip=127.0.0.1 ;; '[::]') drdsh_ip='[::1]' ;; esac
if [ -n "${DSH_RELAY_TLS_CERT:-}" ] || [ -n "${DSH_RELAY_TLS_KEY:-}" ]; then
  drdsh_name=${DSH_RELAY_TLS_SERVER_NAME:-$drdsh_ip}
  set --
  if [ "$drdsh_name" != "$drdsh_ip" ]; then
    set -- --resolve "$drdsh_name:$drdsh_port:$drdsh_ip"
  fi
  case "${DRDSH_TLS_INSECURE-0}" in
    1) set -- "$@" --insecure ;;
    0) if [ -n "${DRDSH_CA_CERT:-}" ]; then set -- "$@" --cacert "$DRDSH_CA_CERT"; fi ;;
    *) echo 'Invalid DRDSH_TLS_INSECURE for the HTTPS health check; set 1 to skip certificate verification or 0 to verify.' >&2; exit 1 ;;
  esac
  exec curl --fail --silent --show-error --noproxy '*' --max-time 2 --tlsv1.2 "$@" "https://$drdsh_name:$drdsh_port/healthz"
fi
exec curl --fail --silent --show-error --noproxy '*' --max-time 2 "http://$drdsh_ip:$drdsh_port/healthz"
