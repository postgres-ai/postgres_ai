.PHONY: up up-local down logs

up:
	docker compose up

up-local:
	docker compose -f docker-compose.yml -f docker-compose.local.yml up --build

down:
	docker compose down

logs:
	docker compose logs -f


