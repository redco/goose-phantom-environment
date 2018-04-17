FROM node:8.6.0

MAINTAINER Andrew Reddikh <andrew@reddikh.com>

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

ARG ENVIRONMENT
ENV ENVIRONMENT $ENVIRONMENT

COPY package.json /usr/src/app
COPY yarn.lock /usr/src/app
COPY docker/build.js /usr/src/app

RUN node ./build.js
RUN yarn install --production --no-progress
RUN rm ./build.js
