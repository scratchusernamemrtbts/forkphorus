/// <reference path="suite.js" />

(function() {
  'use strict';

  const tests = [
    'sb/scratch1.sb',

    'sb2/sb2-template.sb2',
    'sb2/non-standard-json.sb2',

    'sb3/sb3-template.sb3',
    'sb3/quicksort.sb3',
    'sb3/befunge-eratosthenes.sb3',
    'sb3/string-functions.sb3',
    'sb3/operators.sb3',
    'sb3/54-pen-colors.sb3',
    'sb3/56-NaN.sb3',
    'sb3/58-list-reference.sb3',
    'sb3/63-random.sb3',
    'sb3/66-insert.sb3',
    'sb3/70.sb3',
    'sb3/105-contains.sb3',
    'sb3/112.sb3',
    'sb3/for-each-in.sb3',
    'sb3/264-setCostume.sb3',
    'sb3/263-NaN.sb3',
    'sb3/285-variable-id-name-desync.sb3',
    'sb3/when-greater-than.sb3',
  ];

  /**
   * Default options to override the default options
   * @type {Partial<ProjectMeta>}
   */
  const defaultMetadata = {
    timeout: 5000,
    ignoredFailures: [],
    repeatCount: 1,
  };

  /**
   * @param {string} path
   * @param {Partial<ProjectMeta>} metadata 
   * @returns {ProjectMeta}
   */
  function createProjectMeta(path, metadata = {}) {
    metadata.path = path;
    const clonedDefaults = Object.assign({}, defaultMetadata);
    const merged = Object.assign(clonedDefaults, metadata);
    return /** @type {ProjectMeta} */ (merged);
  }

  P.suite.tests = () => tests.map((i) => {
    if (typeof i === 'string') return createProjectMeta(i);
    return i;
  });
  P.suite.defaults = defaultMetadata;
}());
