import { DefaultAzureCredential } from "@azure/identity";

const credential = new DefaultAzureCredential();
const cognitiveServicesScope = "https://cognitiveservices.azure.com/.default";

export async function azureBearerToken() {
  const token = await credential.getToken(cognitiveServicesScope);
  if (!token) throw new Error("MODEL_UNAVAILABLE");
  return token.token;
}