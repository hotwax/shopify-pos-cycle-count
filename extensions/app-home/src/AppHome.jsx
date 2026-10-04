import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {readOmsSetting, saveOmsSetting} from '../../../shared/oms-settings';

export default async () => render(<AppHome />, document.body);

function AppHome() {
  const [setting, setSetting] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    readOmsSetting().then(value => {setSetting(value); setUrl(value.url);})
      .catch(failure => setError(failure.message)).finally(() => setBusy(false));
  }, []);
  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {const value = await saveOmsSetting(setting, url); setSetting(value); setUrl(value.url); setSaved(true);}
    catch (failure) {setError(failure instanceof Error ? failure.message : 'Unable to save the connection.');}
    finally {setBusy(false);}
  }
  return <s-page heading="HotWax Cycle Count">
    <s-section heading="OMS connection">
      <s-stack direction="block" gap="base">
        <s-paragraph>Connect this shop to your HotWax OMS, then open HotWax Cycle Count in Shopify POS.</s-paragraph>
        {error && <s-banner tone="critical" heading="Connection needs attention">{error}</s-banner>}
        {saved && <s-banner tone="success" heading="Connection saved">Reopen HotWax Cycle Count in POS to use this connection.</s-banner>}
        <s-text-field label="OMS URL" value={url} placeholder="https://your-instance.hotwax.io"
          disabled={busy} onInput={event => {setUrl(event.currentTarget.value); setSaved(false);}} />
        <s-button variant="primary" disabled={busy || !setting || !url.trim()} onClick={save}>
          {busy ? 'Loading…' : 'Save connection'}
        </s-button>
        <s-paragraph>Your OMS must also have this Shopify app registered for staff sign-in.</s-paragraph>
      </s-stack>
    </s-section>
    <s-section heading="Count on the shop floor">
      <s-paragraph>Add the HotWax Cycle Count tile in POS. Scans are saved on the device, grouped into count items, and synchronized with OMS while the count is open.</s-paragraph>
    </s-section>
  </s-page>;
}
