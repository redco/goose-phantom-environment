#!/bin/sh

environmentName="phantom";
environment="goose-${environmentName}-environment";
environmentVersion=`npm show goose-${environmentName}-environment version`;

echo "Building image for $1";
IMAGE_NAME="redcode/goose-${environmentName}-environment";
TAG_NAME_VERSIONED="${IMAGE_NAME}:${environmentVersion}";
TAG_NAME_LATEST="${IMAGE_NAME}:latest";
docker build --build-arg ENVIRONMENT=$environment -t "$TAG_NAME_VERSIONED" -t "$TAG_NAME_LATEST" -f ./Dockerfile .
docker tag "$TAG_NAME_VERSIONED" "$TAG_NAME_VERSIONED"
docker tag "$TAG_NAME_LATEST" "$TAG_NAME_LATEST"
docker push "$TAG_NAME_VERSIONED"
docker push "$TAG_NAME_LATEST"
docker rmi "$TAG_NAME_VERSIONED" "$TAG_NAME_VERSIONED"
