# Renders the terminal demo videos with VHS (github.com/charmbracelet/vhs),
# which draws a macOS-style window around a scripted terminal session.
# Node is added so the tape can run `npx zerostel`. Everything happens inside
# the container: nothing is installed on the machine that runs it.
#
#   cd docs/demo && docker build -t zerostel-vhs .
#   docker run --rm -v "${PWD}:/vhs" zerostel-vhs demo.tape

FROM node:22-bookworm-slim AS node

FROM ghcr.io/charmbracelet/vhs:v0.12.1
COPY --from=node /usr/local/ /usr/local/
# Zerostel keeps its snapshots with git
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
