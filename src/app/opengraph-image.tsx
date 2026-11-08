import { ImageResponse } from 'next/og';
import { PRO_PRICE_LABEL } from '@/lib/billing';
import { SUPPORTED_STATES } from '@/lib/rules';

// The og:image for every page (Next adds the meta tags). Prerendered once at build time.
export const alt = `LienClock: preliminary-notice and lien deadlines for subcontractors in ${SUPPORTED_STATES.length} states. ${PRO_PRICE_LABEL}, no per-notice fees.`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#1f3a5f',
          color: '#ffffff',
        }}
      >
        <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: '#f2c14e' }}>LienClock</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>Which lien clocks just started?</div>
          <div style={{ display: 'flex', fontSize: 34, marginTop: 28, color: '#d9e2ef' }}>
            {`Preliminary-notice and lien deadlines for subcontractors in ${SUPPORTED_STATES.length} states, with the statute behind each date.`}
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 34, color: '#f2c14e' }}>{`Alerts before they lapse · ${PRO_PRICE_LABEL}, no per-notice fees`}</div>
      </div>
    ),
    size,
  );
}
