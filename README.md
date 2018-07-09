# Goose Phantom Environment

[![Build Status](https://img.shields.io/circleci/project/github/redco/goose-phantom-environment.svg?style=flat)](https://circleci.com/gh/redco/goose-phantom-environment)
[![Latest Stable Version](https://img.shields.io/npm/v/goose-phantom-environment.svg?style=flat)](https://www.npmjs.com/package/goose-phantom-environment)
[![Total Downloads](https://img.shields.io/npm/dt/goose-phantom-environment.svg?style=flat)](https://www.npmjs.com/package/goose-phantom-environment)

Environment for Goose parser which allows to run it in PhantomJS

## PhantomEnvironment
That environment is used for running Parser on node.
```JS
var env = new PhantomEnvironment({
    url: 'http://google.com',
});
```
The main and only required parameter is `url`. It contains an url address of the site, where Parser will start.

This environment allows to perform snapshots, use proxy lists, custom proxy rotator, white and black lists for loading resources and more sweet features. Find more info about options in [here](https://github.com/redco/goose-parser/blob/master/lib/PhantomEnvironment.js#L35).

## Tests
To run [tests](https://github.com/redco/goose-parser/blob/master/tests/phantom_parser_test.js) use command:
```bash
npm test
```
