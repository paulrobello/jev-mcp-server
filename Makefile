.PHONY: help install build test lint fmt fmt-check typecheck checkall pre-commit

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'

install: ## Install bun dependencies
	bun install

build: ## Typecheck (no emit bundle; runtime is bun)
	bunx tsc --noEmit

test: ## Run bun:test
	bun test

lint: ## Lint with Biome
	bunx biome check .

fmt: ## Format with Biome (writes)
	bunx biome format --write .

fmt-check: ## Check formatting without writing
	bunx biome format .

typecheck: ## Type-check with tsc --noEmit
	bunx tsc --noEmit

checkall: fmt-check lint typecheck test ## Gate before commit

pre-commit: ## Run all pre-commit hooks
	pre-commit run --all-files
