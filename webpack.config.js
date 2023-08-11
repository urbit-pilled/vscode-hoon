/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** @type WebpackConfig */
const webExtensionConfig = {
	mode: 'development', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
	target: 'webworker', // extensions run in a webworker context
	entry: {
		'extension': './src/web/extension.ts',
	},
	output: {
		filename: '[name].js',
		path: path.join(__dirname, './dist/web'),
		clean: true,
		libraryTarget: 'commonjs',
		devtoolModuleFilenameTemplate: '../../[resource-path]'
	},
	resolve: {
		mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
		extensions: ['.ts', '.js'], // support ts-files and js-files
		alias: {
			// provides alternate implementation for node module and source files
            'path': require.resolve('path-browserify'),
		},
		fallback: {
			// Webpack 5 no longer polyfills Node.js core modules automatically.
			// see https://webpack.js.org/configuration/resolve/#resolvefallback
			// for the list of Node.js core module polyfills.
			'assert': require.resolve('assert'),
			'fs': require.resolve('graceful-fs'),
			'util': require.resolve('util'),
			'constants': require.resolve('constants-browserify'),
			'stream': require.resolve('stream-browserify'),
			// 'assert': false,
            // 'fs': false
		}
	},
	module: {
		rules: [{
			test: /\.ts$/,
			exclude: /node_modules/,
			use: [{
				loader: 'ts-loader'
			}]
		},
        {
            test: /\.json$/,
            exclude: /node_modules/,
            use: 'raw-loader',
			type: 'javascript/auto'
        },
		{
			test: /\.wasm$/,
			loader: 'file-loader',
			type: 'javascript/auto',
		}
	]
	},
	plugins: [
		new webpack.optimize.LimitChunkCountPlugin({
			maxChunks: 1 // disable chunks by default since web extensions must be a single bundle
		}),
		new webpack.ProvidePlugin({
			process: 'process/browser', // provide a shim for the global `process` variable
		}),
		// new CopyWebpackPlugin({
		// 	patterns: [
		// 	  { from: 'src/tree-sitter.wasm', to: 'tree-sitter.wasm' },
		// 	],
		//   }),
  
	],
	externals: {
		'vscode': 'commonjs vscode', // ignored because it doesn't exist
	},
	performance: {
		hints: false
	},
	devtool: 'nosources-source-map', // create a source map that points to the original source file
	infrastructureLogging: {
		level: "log", // enables logging required for problem matchers
	},
	stats: 'verbose'
	// devServer: {
	// 	contentBase: './dist',
	// 	historyApiFallback: true,
	// 	writeToDisk: true,
	//   },
};

module.exports = [ webExtensionConfig ];