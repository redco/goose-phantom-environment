FROM node:8.6.0

MAINTAINER Andrew Reddikh <andrew@reddikh.com>

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

ARG ENVIRONMENT
ENV ENVIRONMENT $ENVIRONMENT

ADD https://github.com/Yelp/dumb-init/releases/download/v1.2.1/dumb-init_1.2.1_amd64 /usr/local/bin/dumb-init
RUN chmod +x /usr/local/bin/dumb-init

COPY package.json /usr/src/app
COPY yarn.lock /usr/src/app
COPY docker/build.js /usr/src/app

RUN node ./build.js
RUN yarn install --production --no-progress
RUN rm ./build.js
