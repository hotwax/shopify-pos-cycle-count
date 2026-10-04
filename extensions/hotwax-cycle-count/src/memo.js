import {h} from 'preact';
// preact/compat's memo, without the rest of compat (it would cost several KB of
// the 64 KB bundle limit). Preact calls function components with their
// component instance as `this`, which is how compat implements it too.
const changed = (a, b) => {for (const key in a) if (a[key] !== b[key]) return true; for (const key in b) if (!(key in a)) return true; return false;};
export function memo(Component) {
  function Memo(props) {
    this.shouldComponentUpdate = next => changed(this.props, next);
    return h(Component, props);
  }
  Memo.displayName = `Memo(${Component.displayName || Component.name})`;
  return Memo;
}
