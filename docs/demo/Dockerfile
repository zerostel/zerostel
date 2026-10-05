# Renders the terminal demo videos with VHS (github.com/charmbracelet/vhs),
# which draws a macOS-style window around a scripted terminal session.
# Node is added so the tape can run `npx zerostel`. Everything happens inside
# the container: nothing is installed on the machine that runs it.
#
#   cd docs/demo && docker build -t zerostel-vhs .
#   docker run --rm -v "${PWD}:/vhs" zerostel-vhs demo.tape

# pinned by digest, like the actions in .github/workflows
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node

FROM ghcr.io/charmbracelet/vhs:v0.12.1@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3
COPY --from=node /usr/local/ /usr/local/
# Zerostel keeps its snapshots with git
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
