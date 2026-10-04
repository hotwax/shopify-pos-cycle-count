import {memo} from './memo';
import {useRef, useEffect, useState} from "preact/hooks";
// POS TextField has no Return event. A one-row native TextArea delivers the
// HID scanner's CR/LF suffix through onInput and keeps focus between scans.
// Keep this control mounted while count/status notifications update its parent.
function HidBarcodeInput({disabled, add}) {
  const [failed, setFailed] = useState([]);
  const active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  async function submit(code) {
    let saved = false;
    try {saved = !!await add({code, source: "hid", quantity: 1});} catch { /* Retain visible failure feedback below. */ }
    if (!active.current) return;
    setFailed(previous => {
      if (!saved) return [...previous, code];
      const retried = previous.indexOf(code);
      return retried < 0 ? previous : [...previous.slice(0,retried), ...previous.slice(retried+1)];
    });
  }
  return <s-text-area label="Barcode" rows={1} disabled={disabled}
    placeholder="Scan a barcode, then press Return"
    details="Tap this field once. Each scan ending with Return adds one unit."
    error={failed.length ? `Not saved (${failed.length} scans): ${failed.slice(0,3).join(', ')}${failed.length>3?` and ${failed.length-3} more`:''}. Scan these barcodes again.` : undefined}
    onInput={event => {
      if (disabled) return;
      const value = event.currentTarget.value;
      if (!/[\r\n]/.test(value)) return;
      const lines = value.split(/\r\n|\r|\n/), remainder = lines.pop();
      // Clear only complete scans, preserving any partially received next code.
      event.currentTarget.value = remainder;
      // CountState serializes durable writes. Repeated identical scans are units,
      // so accept each Return independently rather than debouncing the barcode.
      for (const code of lines.map(line => line.trim()).filter(Boolean)) void submit(code);
    }}/>
}
export const HidBarcodeEntry = memo(HidBarcodeInput);
