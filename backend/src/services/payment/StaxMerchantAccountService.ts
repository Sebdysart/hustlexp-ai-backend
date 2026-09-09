import { db } from '../../db.js';
import { decryptStaxCredential, encryptStaxCredential, fingerprintStaxCredential } from './StaxCredentialEncryption.js';

export interface ActiveStaxMerchantAccount { accountId:string; organizationId:string; merchantId:string; hostedPaymentsToken:string; apiKey:string; }
export const StaxMerchantAccountService = {
  async resolveActiveForOrganization(organizationId:string):Promise<ActiveStaxMerchantAccount|null> {
    const r=await db.query<any>(`SELECT id,organization_id,stax_merchant_id,hosted_payments_token,encrypted_api_key,onboarding_status,payments_enabled FROM business_stax_merchant_accounts WHERE organization_id=$1 LIMIT 1`,[organizationId]);
    const row=r.rows[0];
    if(!row || row.onboarding_status!=='ACTIVE' || row.payments_enabled!==true) return null;
    return {accountId:row.id,organizationId:row.organization_id,merchantId:row.stax_merchant_id,hostedPaymentsToken:row.hosted_payments_token,apiKey:decryptStaxCredential(row.encrypted_api_key)};
  },
  async upsertMerchantAccount(input:{organizationId:string;merchantId:string;hostedPaymentsToken:string;apiKey:string;onboardingStatus?:string;paymentsEnabled?:boolean;providerStatusSnapshot?:Record<string,unknown>}):Promise<void>{
    const enc=encryptStaxCredential(input.apiKey); const fp=fingerprintStaxCredential(input.apiKey);
    await db.query(`INSERT INTO business_stax_merchant_accounts (organization_id,stax_merchant_id,hosted_payments_token,encrypted_api_key,api_key_fingerprint,onboarding_status,payments_enabled,provider_status_snapshot,verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,CASE WHEN $7=TRUE AND $6='ACTIVE' THEN NOW() ELSE NULL END) ON CONFLICT (organization_id) DO UPDATE SET stax_merchant_id=EXCLUDED.stax_merchant_id,hosted_payments_token=EXCLUDED.hosted_payments_token,encrypted_api_key=EXCLUDED.encrypted_api_key,api_key_fingerprint=EXCLUDED.api_key_fingerprint,onboarding_status=EXCLUDED.onboarding_status,payments_enabled=EXCLUDED.payments_enabled,provider_status_snapshot=EXCLUDED.provider_status_snapshot,verified_at=EXCLUDED.verified_at,updated_at=NOW()`,[input.organizationId,input.merchantId,input.hostedPaymentsToken,enc,fp,input.onboardingStatus??'PENDING',input.paymentsEnabled??false,JSON.stringify(input.providerStatusSnapshot??{})]);
  },
};
