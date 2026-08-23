function contractParameters(direction, config) {
  const parameters = {
    amount: Number(config.stake),
    basis: 'stake',
    contract_type: direction,
    currency: config.currency || 'USD',
    duration: Number(config.duration),
    duration_unit: config.durationUnit,
    underlying_symbol: config.symbol
  };
  if (config.barrier !== undefined && config.barrier !== null && String(config.barrier) !== '') {
    parameters.barrier = String(config.barrier);
  }
  if (config.barrier2 !== undefined && config.barrier2 !== null && String(config.barrier2) !== '') {
    parameters.barrier2 = String(config.barrier2);
  }
  return parameters;
}

export function directBuyRequest(direction, config, reqId) {
  return {
    buy: '1',
    price: Number(config.stake),
    parameters: contractParameters(direction, config),
    req_id: reqId
  };
}

export function proposalRequest(direction, config, reqId) {
  return {
    proposal: 1,
    ...contractParameters(direction, config),
    req_id: reqId
  };
}
