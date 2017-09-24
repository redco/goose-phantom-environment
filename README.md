# Goose Phantom Environment

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
