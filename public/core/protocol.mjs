export function directBuyRequest(direction, config, reqId) {
  return {
    buy: '1',
    price: Number(config.stake),
    parameters: {
      amount: Number(config.stake),
      basis: 'stake',
      contract_type: direction,
      currency: config.currency || 'USD',
      duration: Number(config.duration),
      duration_unit: config.durationUnit,
      underlying_symbol: config.symbol
    },
    req_id: reqId
  };
}
export function proposalRequest(direction, config, reqId) {
  return {
    proposal: 1, amount: Number(config.stake), basis:'stake', contract_type:direction,
    currency:config.currency || 'USD', duration:Number(config.duration), duration_unit:config.durationUnit,
    underlying_symbol:config.symbol, req_id:reqId
  };
}
