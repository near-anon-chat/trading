#!/bin/bash
# Test which tokens have swap routes available via 1Click

TOKENS=(
  "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near:AURORA-(NEAR)"
  "nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near:VVV-(Base)"
  "nep141:sol-c634d063ceff771aff0c972ec396fd915a6bbd0e.omft.near:SPX-(Sol)"
  "nep141:eth-0xdef1b2d939edc0e4d35806c59b3166f790175afe.omft.near:INX-(Eth)"
  "nep141:bera.omft.near:BERA"
  "nep141:base-0x98d0baa52b2d063e780de12f615f963fe8537553.omft.near:KAITO-(Base)"
  "nep141:base-0x532f27101965dd16442e59d40670faf5ebb142e4.omft.near:BRETT-(Base)"
  "nep141:eth-0x07bcef151322163d8d5a0be327fe5b6f77f452b6.omft.near:saETH"
  "nep141:eth-0x0c94b344e1b447a420490a330fea54138d7e8462.omft.near:ENA"
  "nep141:eth-0x57a12e2d4b2cd3a4621c6022bb6fcbee8b992a81.omft.near:SCIHUB"
  "nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near:PEPE"
  "nep141:eth-0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce.omft.near:SHIB"
  "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near:PENGU-(Sol)"
  "nep141:sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near:BOME-(Sol)"
  "nep141:aptos.omft.near:APT-(Aptos)"
  "nep141:sol.omft.near:SOL-(Sol)"
  "nep141:xrp.omft.near:XRP"
)

for entry in "${TOKENS[@]}"; do
  asset_id="${entry%%:*}"
  label="${entry##*:}"
  
  result=$(curl -s -X POST 'https://1click.chaindefuser.com/v0/quote' \
    -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{
      \"dry\": true,
      \"swapType\": \"EXACT_INPUT\",
      \"depositMode\": \"SIMPLE\",
      \"slippageTolerance\": 100,
      \"originAsset\": \"nep141:wrap.near\",
      \"destinationAsset\": \"$asset_id\",
      \"amount\": \"100000000000000000000000\",
      \"recipient\": \"dummy.near\",
      \"recipientType\": \"DESTINATION_CHAIN\",
      \"deadline\": \"2026-06-12T14:00:00.000Z\"
    }" 2>&1)
  
  if echo "$result" | jq -e '.quote.amountOut' > /dev/null 2>&1; then
    amt=$(echo "$result" | jq -r '.quote.amountOutFormatted')
    spread=$(echo "$result" | jq -r '.quote.withdrawFee // empty')
    echo "✅ $label -> $amt (withdrawFee: $spread)"
  else
    echo "❌ $label - no route"
  fi
done
