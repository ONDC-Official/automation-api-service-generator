# Build stage - build plugins only
FROM golang:1.25.5 AS plugin-builder

WORKDIR /temp

# Copy temp directory with plugins
COPY temp/ .

# Build the plugins
WORKDIR /temp/automation-beckn-plugins
RUN chmod +x buildplugins.sh && ./buildplugins.sh /plugins

# Runtime stage - use pre-built onix server
FROM ghcr.io/ondc-official/automation-beckn-onix:latest

# The base image has server at /workspace/app/server
WORKDIR /workspace/app

# Copy plugins from plugin-builder
COPY --from=plugin-builder /plugins ./plugins

COPY temp/schemas ./schemas

# Copy temp config and validationpkg from host
COPY temp/config ./config
# COPY temp/validationpkg ./validationpkg

# Copy .env file if exists
COPY .env ./.env

# Expose port (adjust if needed)
# EXPOSE 8080

# Run the server with config
CMD ["./server", "--config=./config/adapter.yaml"]