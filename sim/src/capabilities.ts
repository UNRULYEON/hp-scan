/**
 * ScannerCapabilities for an HP OfficeJet Pro 7740 Wide Format AiO.
 *
 * Dimensions are in eSCL units of 1/300 inch. The 7740 takes up to A3 / 11x17
 * on both the platen and the (duplexing, 35-sheet) feeder:
 *   11.69in * 300 = 3507   17in * 300 = 5100
 *
 * These values are modelled on the device's published specs. When the real
 * printer is on hand, replace this wholesale with a verbatim dump of
 * GET /eSCL/ScannerCapabilities so the simulator is byte-accurate.
 */

const MAX_W = 3507;
const MAX_H = 5100;

const PLATEN_RESOLUTIONS = [75, 100, 200, 300, 600, 1200];
const FEEDER_RESOLUTIONS = [75, 100, 200, 300, 600];

function discreteResolutions(dpis: number[]): string {
  return dpis
    .map(
      (d) => `            <scan:DiscreteResolution>
              <scan:XResolution>${d}</scan:XResolution>
              <scan:YResolution>${d}</scan:YResolution>
            </scan:DiscreteResolution>`,
    )
    .join("\n");
}

function settingProfile(dpis: number[]): string {
  return `        <scan:SettingProfile>
          <scan:ColorModes>
            <scan:ColorMode>BlackAndWhite1</scan:ColorMode>
            <scan:ColorMode>Grayscale8</scan:ColorMode>
            <scan:ColorMode>RGB24</scan:ColorMode>
          </scan:ColorModes>
          <scan:DocumentFormats>
            <pwg:DocumentFormat>application/pdf</pwg:DocumentFormat>
            <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
            <scan:DocumentFormatExt>application/pdf</scan:DocumentFormatExt>
            <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
          </scan:DocumentFormats>
          <scan:SupportedResolutions>
            <scan:DiscreteResolutions>
${discreteResolutions(dpis)}
            </scan:DiscreteResolutions>
          </scan:SupportedResolutions>
        </scan:SettingProfile>`;
}

function inputCaps(dpis: number[]): string {
  return `      <scan:MinWidth>16</scan:MinWidth>
      <scan:MaxWidth>${MAX_W}</scan:MaxWidth>
      <scan:MinHeight>16</scan:MinHeight>
      <scan:MaxHeight>${MAX_H}</scan:MaxHeight>
      <scan:MaxScanRegions>1</scan:MaxScanRegions>
      <scan:SettingProfiles>
${settingProfile(dpis)}
      </scan:SettingProfiles>
      <scan:MaxOpticalXResolution>1200</scan:MaxOpticalXResolution>
      <scan:MaxOpticalYResolution>1200</scan:MaxOpticalYResolution>`;
}

export const SCANNER_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities
    xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"
    xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version>
  <pwg:MakeAndModel>HP OfficeJet Pro 7740</pwg:MakeAndModel>
  <pwg:SerialNumber>CN0SIM0001</pwg:SerialNumber>
  <scan:UUID>3ca9a1d0-1f4b-4c8a-9f1e-0a5b7c2d9e00</scan:UUID>
  <scan:AdminURI>http://%HOST%/</scan:AdminURI>
  <scan:IconURI>http://%HOST%/icon.png</scan:IconURI>
  <scan:Platen>
    <scan:PlatenInputCaps>
${inputCaps(PLATEN_RESOLUTIONS)}
    </scan:PlatenInputCaps>
  </scan:Platen>
  <scan:Adf>
    <scan:AdfSimplexInputCaps>
${inputCaps(FEEDER_RESOLUTIONS)}
    </scan:AdfSimplexInputCaps>
    <scan:AdfDuplexInputCaps>
${inputCaps(FEEDER_RESOLUTIONS)}
    </scan:AdfDuplexInputCaps>
    <scan:FeederCapacity>35</scan:FeederCapacity>
    <scan:AdfOptions>
      <scan:AdfOption>DetectPaperLoaded</scan:AdfOption>
      <scan:AdfOption>Duplex</scan:AdfOption>
    </scan:AdfOptions>
  </scan:Adf>
  <scan:CompressionFactorSupport>
    <scan:Min>1</scan:Min>
    <scan:Max>100</scan:Max>
    <scan:Normal>50</scan:Normal>
    <scan:Step>1</scan:Step>
  </scan:CompressionFactorSupport>
</scan:ScannerCapabilities>
`;

export function capabilitiesFor(host: string): string {
  return SCANNER_CAPABILITIES.replaceAll("%HOST%", host);
}
