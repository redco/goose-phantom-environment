#!/bin/sh

environmentName="phantom";
environment="goose-${environmentName}-environment";
environmentVersion=`npm show goose-${environmentName}-environment version`;

echo "Building image for $1";
IMAGE_NAME="redcode/goose-phantom-environment";
TAG_NAME_VERSIONED="${environmentName}-${environmentVersion}";
TAG_NAME_LATEST="${environmentName}-latest";
docker build --build-arg ENVIRONMENT=$environment -t "$TAG_NAME_VERSIONED" -t "$TAG_NAME_LATEST" -f ./Dockerfile .
DOCKER_NAME_VERSIONED="$IMAGE_NAME:$TAG_NAME_VERSIONED"
DOCKER_NAME_LATEST="$IMAGE_NAME:$TAG_NAME_LATEST"
docker tag "$TAG_NAME_VERSIONED" "$DOCKER_NAME_VERSIONED"
docker tag "$TAG_NAME_LATEST" "$DOCKER_NAME_LATEST"
docker push "$DOCKER_NAME_VERSIONED"
docker push "$DOCKER_NAME_LATEST"
docker rmi "$DOCKER_NAME_VERSIONED" "$DOCKER_NAME_LATEST"
