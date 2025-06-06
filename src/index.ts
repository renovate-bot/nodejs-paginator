/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module common/paginator
 */

import * as extend from 'extend';
import {TransformOptions} from 'stream';
import {ResourceStream} from './resource-stream';

export interface ParsedArguments extends TransformOptions {
  /**
   * Query object. This is most commonly an object, but to make the API more
   * simple, it can also be a string in some places.
   */
  query?: ParsedArguments;

  /**
   * Callback function.
   */
  callback?: Function;

  /**
   * Auto-pagination enabled.
   */
  autoPaginate?: boolean;

  /**
   * Maximum API calls to make.
   */
  maxApiCalls?: number;

  /**
   * Maximum results to return.
   */
  maxResults?: number;

  pageSize?: number;

  streamOptions?: ParsedArguments;
}

/*! Developer Documentation
 *
 * paginator is used to auto-paginate `nextQuery` methods as well as
 * streamifying them.
 *
 * Before:
 *
 *   search.query('done=true', function(err, results, nextQuery) {
 *     search.query(nextQuery, function(err, results, nextQuery) {});
 *   });
 *
 * After:
 *
 *   search.query('done=true', function(err, results) {});
 *
 * Methods to extend should be written to accept callbacks and return a
 * `nextQuery`.
 */

export class Paginator {
  /**
   * Cache the original method, then overwrite it on the Class's prototype.
   *
   * @param {function} Class - The parent class of the methods to extend.
   * @param {string|string[]} methodNames - Name(s) of the methods to extend.
   */
  // tslint:disable-next-line:variable-name
  extend(Class: Function, methodNames: string | string[]) {
    if (typeof methodNames === 'string') {
      methodNames = [methodNames];
    }
    methodNames.forEach(methodName => {
      const originalMethod = Class.prototype[methodName];

      // map the original method to a private member
      Class.prototype[methodName + '_'] = originalMethod;

      // overwrite the original to auto-paginate
      /* eslint-disable  @typescript-eslint/no-explicit-any */
      Class.prototype[methodName] = function (...args: any[]) {
        const parsedArguments = paginator.parseArguments_(args);
        return paginator.run_(parsedArguments, originalMethod.bind(this));
      };
    });
  }

  /**
   * Wraps paginated API calls in a readable object stream.
   *
   * This method simply calls the nextQuery recursively, emitting results to a
   * stream. The stream ends when `nextQuery` is null.
   *
   * `maxResults` will act as a cap for how many results are fetched and emitted
   * to the stream.
   *
   * @param {string} methodName - Name of the method to streamify.
   * @return {function} - Wrapped function.
   */
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  streamify<T = any>(methodName: string) {
    return function (
      // tslint:disable-next-line:no-any
      this: {[index: string]: Function},
      /* eslint-disable  @typescript-eslint/no-explicit-any */
      ...args: any[]
    ): ResourceStream<T> {
      const parsedArguments = paginator.parseArguments_(args);
      const originalMethod = this[methodName + '_'] || this[methodName];
      return paginator.runAsStream_<T>(
        parsedArguments,
        originalMethod.bind(this),
      );
    };
  }

  /**
   * Parse a pseudo-array `arguments` for a query and callback.
   *
   * @param {array} args - The original `arguments` pseduo-array that the original
   *     method received.
   */
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  parseArguments_(args: any[]) {
    let query: string | ParsedArguments | undefined;
    let autoPaginate = true;
    let maxApiCalls = -1;
    let maxResults = -1;
    let callback: Function | undefined;

    const firstArgument = args[0];
    const lastArgument = args[args.length - 1];

    if (typeof firstArgument === 'function') {
      callback = firstArgument;
    } else {
      query = firstArgument;
    }

    if (typeof lastArgument === 'function') {
      callback = lastArgument;
    }

    if (typeof query === 'object') {
      query = extend<{}, ParsedArguments>(true, {}, query) as ParsedArguments;

      // Check if the user only asked for a certain amount of results.
      if (query.maxResults && typeof query.maxResults === 'number') {
        // `maxResults` is used API-wide.
        maxResults = query.maxResults;
      } else if (typeof query.pageSize === 'number') {
        // `pageSize` is Pub/Sub's `maxResults`.
        maxResults = query.pageSize!;
      }

      if (query.maxApiCalls && typeof query.maxApiCalls === 'number') {
        maxApiCalls = query.maxApiCalls;
        delete query.maxApiCalls;
      }

      // maxResults is the user specified limit.
      if (maxResults !== -1 || query.autoPaginate === false) {
        autoPaginate = false;
      }
    }

    const parsedArguments = {
      query: query || {},
      autoPaginate,
      maxApiCalls,
      maxResults,
      callback,
    } as ParsedArguments;

    parsedArguments.streamOptions = extend<{}, ParsedArguments>(
      true,
      {},
      parsedArguments.query as ParsedArguments,
    );
    delete parsedArguments.streamOptions.autoPaginate;
    delete parsedArguments.streamOptions.maxResults;
    delete parsedArguments.streamOptions.pageSize;

    return parsedArguments;
  }

  /**
   * This simply checks to see if `autoPaginate` is set or not, if it's true
   * then we buffer all results, otherwise simply call the original method.
   *
   * @param {array} parsedArguments - Parsed arguments from the original method
   *     call.
   * @param {object=|string=} parsedArguments.query - Query object. This is most
   *     commonly an object, but to make the API more simple, it can also be a
   *     string in some places.
   * @param {function=} parsedArguments.callback - Callback function.
   * @param {boolean} parsedArguments.autoPaginate - Auto-pagination enabled.
   * @param {boolean} parsedArguments.maxApiCalls - Maximum API calls to make.
   * @param {number} parsedArguments.maxResults - Maximum results to return.
   * @param {function} originalMethod - The cached method that accepts a callback
   *     and returns `nextQuery` to receive more results.
   */
  run_(parsedArguments: ParsedArguments, originalMethod: Function) {
    const query = parsedArguments.query;
    const callback = parsedArguments.callback!;
    if (!parsedArguments.autoPaginate) {
      return originalMethod(query, callback);
    }
    const results = new Array<{}>();
    let otherArgs: unknown[] = [];
    const promise = new Promise((resolve, reject) => {
      const stream = paginator.runAsStream_(parsedArguments, originalMethod);
      stream
        .on('error', reject)
        .on('data', (data: {}) => results.push(data))
        .on('end', () => {
          otherArgs = stream._otherArgs || [];
          resolve(results);
        });
    });
    if (!callback) {
      return promise.then(results => [results, query, ...otherArgs]);
    }
    promise.then(
      results => callback(null, results, query, ...otherArgs),
      (err: Error) => callback(err),
    );
  }

  /**
   * This method simply calls the nextQuery recursively, emitting results to a
   * stream. The stream ends when `nextQuery` is null.
   *
   * `maxResults` will act as a cap for how many results are fetched and emitted
   * to the stream.
   *
   * @param {object=|string=} parsedArguments.query - Query object. This is most
   *     commonly an object, but to make the API more simple, it can also be a
   *     string in some places.
   * @param {function=} parsedArguments.callback - Callback function.
   * @param {boolean} parsedArguments.autoPaginate - Auto-pagination enabled.
   * @param {boolean} parsedArguments.maxApiCalls - Maximum API calls to make.
   * @param {number} parsedArguments.maxResults - Maximum results to return.
   * @param {function} originalMethod - The cached method that accepts a callback
   *     and returns `nextQuery` to receive more results.
   * @return {stream} - Readable object stream.
   */
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  runAsStream_<T = any>(
    parsedArguments: ParsedArguments,
    originalMethod: Function,
  ): ResourceStream<T> {
    return new ResourceStream<T>(parsedArguments, originalMethod);
  }
}

const paginator = new Paginator();
export {paginator};

export {ResourceStream};
