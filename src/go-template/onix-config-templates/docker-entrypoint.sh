#!/bin/sh

set -eu

CONFIG_DIR="${ONIX_CONFIG_DIR:-/workspace/app/config}"
ADAPTER_FILE="${CONFIG_DIR}/adapter.yaml"
FORM_ROUTER_FILE="${CONFIG_DIR}/form_router.yaml"
MOCK_ROUTER_FILE="${CONFIG_DIR}/mock_router.yaml"
NP_ROUTER_FILE="${CONFIG_DIR}/np_router.yaml"
MOCK_NO_CONFIG_FILE="${CONFIG_DIR}/mock_no_config.yaml"
NP_NO_CONFIG_FILE="${CONFIG_DIR}/np_no_config.yaml"

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

sed_in_place() {
    expression="$1"
    file="$2"

    if sed -i "$expression" "$file" 2>/dev/null; then
        return 0
    fi

    sed -i '' "$expression" "$file"
}

replace_line() {
    file="$1"
    pattern="$2"
    replacement="$3"

    if [ ! -f "$file" ] || [ -z "$replacement" ]; then
        return 0
    fi

    escaped_replacement=$(escape_sed_replacement "$replacement")
    sed_in_place "s|$pattern|$escaped_replacement|" "$file"
}

replace_line_if_value() {
    file="$1"
    value="$2"
    pattern="$3"
    replacement="$4"

    if [ -z "$value" ]; then
        return 0
    fi

    replace_line "$file" "$pattern" "$replacement"
}

trim_trailing_slash() {
    value="$1"
    while [ -n "$value" ] && [ "${value%/}" != "$value" ]; do
        value="${value%/}"
    done
    printf '%s' "$value"
}

render_onix_config() {
    domain="${DOMAIN:-}"
    version="${DOMAIN_VERSION:-${VERSION:-}}"
    port="${PORT:-}"
    config_service_url="${CONFIG_SERVICE_URL:-}"
    mock_service_url="${MOCK_SERVER_URL:-}"
    recorder_service_http_url="${RECORDER_SERVICE_HTTP_URL:-}"
    recorder_service_grpc_url="${RECORDER_SERVICE_GRPC_URL:-}"
    redis_addr="${REDIS_URL:-}"

    if [ -z "$redis_addr" ] && [ -n "${REDIS_HOST:-}" ] && [ -n "${REDIS_PORT:-}" ]; then
        redis_addr="${REDIS_HOST}:${REDIS_PORT}"
    fi

    if [ -z "$redis_addr" ]; then
        echo "docker-entrypoint: missing Redis runtime configuration; set REDIS_URL or REDIS_HOST and REDIS_PORT" >&2
        exit 1
    fi

    replace_line_if_value "$ADAPTER_FILE" "$port" '^  port: .*$' "  port: ${port}"
    replace_line_if_value "$ADAPTER_FILE" "$redis_addr" '^            addr: .*$' "            addr: ${redis_addr}"
    replace_line_if_value "$ADAPTER_FILE" "$version" '^            protocolVersion: .*$' "            protocolVersion: ${version}"
    replace_line_if_value "$ADAPTER_FILE" "$domain" '^            protocolDomain: .*$' "            protocolDomain: ${domain}"
    replace_line_if_value "$ADAPTER_FILE" "$config_service_url" '^            configServiceURL: .*$' "            configServiceURL: ${config_service_url}"
    replace_line_if_value "$ADAPTER_FILE" "$mock_service_url" '^            mockServiceURL: .*$' "            mockServiceURL: ${mock_service_url}"

    replace_line_if_value "$FORM_ROUTER_FILE" "$domain" '^  - domain: .*$' "  - domain: ${domain}"
    replace_line_if_value "$FORM_ROUTER_FILE" "$version" '^    version: .*$' "    version: ${version}"
    replace_line_if_value "$MOCK_ROUTER_FILE" "$domain" '^  - domain: .*$' "  - domain: ${domain}"
    replace_line_if_value "$MOCK_ROUTER_FILE" "$version" '^    version: .*$' "    version: ${version}"
    replace_line_if_value "$NP_ROUTER_FILE" "$domain" '^  - domain: .*$' "  - domain: ${domain}"
    replace_line_if_value "$NP_ROUTER_FILE" "$version" '^    version: .*$' "    version: ${version}"
    replace_line_if_value "$MOCK_NO_CONFIG_FILE" "$recorder_service_grpc_url" '^grpc_target: .*$' "grpc_target: ${recorder_service_grpc_url}"
    replace_line_if_value "$NP_NO_CONFIG_FILE" "$recorder_service_grpc_url" '^grpc_target: .*$' "grpc_target: ${recorder_service_grpc_url}"

    if [ -n "$recorder_service_http_url" ]; then
        recorder_service_http_url=$(trim_trailing_slash "$recorder_service_http_url")
        replace_line "$FORM_ROUTER_FILE" '^      url: .*$' "      url: ${recorder_service_http_url}/html-form"
    fi

    if [ -n "$domain" ] && [ -n "$version" ]; then
        replace_line "$ADAPTER_FILE" '^appName: .*$' "appName: workbench-onix-${domain}-${version}"
        replace_line "$ADAPTER_FILE" '^    path: /api-service/[^/][^/]*/[^/][^/]*/form/html-form$' "    path: /api-service/${domain}/${version}/form/html-form"
        replace_line "$ADAPTER_FILE" '^    path: /api-service/[^/][^/]*/[^/][^/]*/test/$' "    path: /api-service/${domain}/${version}/test/"
        replace_line "$ADAPTER_FILE" '^    path: /api-service/[^/][^/]*/[^/][^/]*/seller/$' "    path: /api-service/${domain}/${version}/seller/"
        replace_line "$ADAPTER_FILE" '^    path: /api-service/[^/][^/]*/[^/][^/]*/buyer/$' "    path: /api-service/${domain}/${version}/buyer/"
        replace_line "$ADAPTER_FILE" '^    path: /api-service/[^/][^/]*/[^/][^/]*/mock/$' "    path: /api-service/${domain}/${version}/mock/"
    fi
}

render_onix_config
exec "$@"
