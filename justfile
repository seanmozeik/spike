alias c := check
alias v := verify
alias i := install
alias d := dev

default:
    @just --list

check:
    bun run check

test:
    bun run test

typecheck:
    bun run typecheck

install:
    bun install

verify:
    bun run verify

build:
    bun run build

dev *args:
    bun run src/cli.ts -- {{ args }}

lint:
    bun run lint

format:
    bun run format
