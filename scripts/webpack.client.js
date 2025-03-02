const path = require('path');
const production = process.argv.includes('production');

module.exports = (dirname, file = 'client') => ({
  mode: production ? 'production' : 'development',
  devtool: production ? false : 'inline-source-map',
  entry: `./src/client/client.tsx`,
  output: {
    jsonpFunction: path.dirname(dirname).replace(/[^a-z]/gi, ''),
    path: path.join(dirname, 'out'),
    filename: `${file}.bundle.js`,
    publicPath: 'http://localhost:8116/',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json', '.svg', '.vert', '.frag'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: { configFile: 'tsconfig.browser.json' },
      },
      {
        test: /\.css$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              modules: true,
            },
          },
          'postcss-loader',
        ],
      },
      {
        test: /\.svg$/,
        loader: 'svg-inline-loader',
      },
      {
        test: /\.(vert|frag)$/,
        loader: 'raw-loader',
      },
    ],
  },
  devServer: {
    allowedHosts: ['null'],
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
