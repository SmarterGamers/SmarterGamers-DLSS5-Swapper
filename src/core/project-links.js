'use strict';

// Only these destinations may be opened by the renderer, never arbitrary URLs.
const links = Object.freeze({
  github: 'https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper',
  releases: 'https://github.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/releases/latest',
  website: 'https://SmarterGamers.com',
  donate: 'https://SmarterGamers.com/donate',
  coffee: 'https://buymeacoffee.com/SmarterGamers'
});
function projectUrl(key) {
  return typeof key === 'string' && Object.hasOwn(links, key) ? links[key] : null;
}
module.exports = { links, projectUrl };
