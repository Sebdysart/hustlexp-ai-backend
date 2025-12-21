
import { SafetyService } from '../src/services/SafetyService';

async function verify() {
    console.log("🛡️ Verifying Safety Service...");

    const badPayload = "I want a refund. cash only meetup behind gym.";
    const result = await SafetyService.moderateContent(badPayload, 'chat');

    console.log(`Payload: "${badPayload}"`);
    console.log("Result:", result);

    if (result.allowed === false && result.riskScore > 0.8) {
        console.log("✅ Safety Check PASSED: High risk content blocked.");
    } else {
        console.error("❌ Safety Check FAILED: Content was not blocked sufficiently.");
        process.exit(1);
    }
}

verify();
