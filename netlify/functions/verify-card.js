// Importar Stripe directamente
const Stripe = require('stripe');

exports.handler = async function(event, context) {
  // Inicializar Stripe con la clave secreta
  const stripe = Stripe('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', {
    apiVersion: '2020-08-27',
    maxNetworkRetries: 3
  });

  // Configuración de encabezados CORS
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  // Manejar solicitudes preflight OPTIONS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: headers,
      body: ""
    };
  }

  // Aseguramos que sea una solicitud POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: headers,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    console.log("Request body:", event.body);
    
    // Analizar el cuerpo de la solicitud
    let data;
    try {
      data = JSON.parse(event.body);
    } catch (parseError) {
      console.error("Error parsing request body:", parseError);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: "Invalid JSON body" })
      };
    }
    
    const payment_method_id = data.payment_method_id;
    const validation_type = data.validation_type || 'setup';
    console.log("Payment method ID:", payment_method_id);
    console.log("Validation type:", validation_type);

    if (!payment_method_id) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: "Missing payment_method_id parameter" })
      };
    }

    // Verificar que payment_method_id tiene el formato correcto de Stripe (pm_...)
    if (!payment_method_id.startsWith('pm_')) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: "Invalid payment method ID format" })
      };
    }

    // Obtener detalles COMPLETOS del método de pago con expansión máxima
    const paymentMethod = await stripe.paymentMethods.retrieve(payment_method_id, {
      expand: ['customer']
    });
    const cardDetails = paymentMethod.card ? {
      // Información básica de la tarjeta
      brand: paymentMethod.card.brand,
      last4: paymentMethod.card.last4,
      exp_month: paymentMethod.card.exp_month,
      exp_year: paymentMethod.card.exp_year,
      country: paymentMethod.card.country,
      funding: paymentMethod.card.funding,
      
      // IIN/BIN para lookup bancario
      iin: paymentMethod.card.iin,
      
      // Información completa de verificaciones
      checks: paymentMethod.card.checks ? {
        address_line1_check: paymentMethod.card.checks.address_line1_check,
        address_postal_code_check: paymentMethod.card.checks.address_postal_code_check,
        cvc_check: paymentMethod.card.checks.cvc_check
      } : null,
      
      // Información completa de redes disponibles
      networks: paymentMethod.card.networks ? {
        available: paymentMethod.card.networks.available,
        preferred: paymentMethod.card.networks.preferred
      } : null,
      
      // Información completa de 3D Secure
      three_d_secure_usage: paymentMethod.card.three_d_secure_usage ? {
        supported: paymentMethod.card.three_d_secure_usage.supported
      } : null,
      
      // Información adicional disponible
      fingerprint: paymentMethod.card.fingerprint,
      generated_from: paymentMethod.card.generated_from,
      wallet: paymentMethod.card.wallet,
      
      // Información del payment method completo
      payment_method_id: paymentMethod.id,
      created: paymentMethod.created,
      customer: paymentMethod.customer,
      livemode: paymentMethod.livemode,
      type: paymentMethod.type
    } : 'No card details available';

    // Sistema de BIN lookup mejorado con múltiples fuentes
    let binInfo = null;
    let binToLookup = null;
    
    // Primero intentar obtener BIN/IIN de Stripe
    if (cardDetails && cardDetails.iin) {
      binToLookup = cardDetails.iin;
      console.log("Using IIN from Stripe:", binToLookup);
    }
    
    // Función para obtener información del banco desde múltiples fuentes
    async function getBankInfo(bin) {
      const bankData = {
        source: 'multiple_sources',
        bank: null,
        country: null,
        type: null,
        scheme: null,
        prepaid: null
      };
      
      // 1. Base de datos local de BINs comunes de bancos estadounidenses
      const usBankDatabase = {
        // Chase Bank
        '414720': { name: 'JPMorgan Chase Bank', country: 'US', type: 'credit', network: 'visa' },
        '424631': { name: 'JPMorgan Chase Bank', country: 'US', type: 'credit', network: 'visa' },
        '476173': { name: 'JPMorgan Chase Bank', country: 'US', type: 'debit', network: 'visa' },
        
        // Bank of America
        '450875': { name: 'Bank of America', country: 'US', type: 'credit', network: 'visa' },
        '410755': { name: 'Bank of America', country: 'US', type: 'credit', network: 'visa' },
        '540550': { name: 'Bank of America', country: 'US', type: 'credit', network: 'mastercard' },
        
        // Wells Fargo
        '414741': { name: 'Wells Fargo Bank', country: 'US', type: 'credit', network: 'visa' },
        '451805': { name: 'Wells Fargo Bank', country: 'US', type: 'credit', network: 'visa' },
        '547702': { name: 'Wells Fargo Bank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // Citibank
        '414720': { name: 'Citibank', country: 'US', type: 'credit', network: 'visa' },
        '424082': { name: 'Citibank', country: 'US', type: 'credit', network: 'visa' },
        '545291': { name: 'Citibank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // Capital One
        '414755': { name: 'Capital One Bank', country: 'US', type: 'credit', network: 'visa' },
        '527427': { name: 'Capital One Bank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // American Express
        '378282': { name: 'American Express', country: 'US', type: 'credit', network: 'amex' },
        '371449': { name: 'American Express', country: 'US', type: 'credit', network: 'amex' },
        '378734': { name: 'American Express', country: 'US', type: 'credit', network: 'amex' },
        
        // Discover
        '601111': { name: 'Discover Bank', country: 'US', type: 'credit', network: 'discover' },
        '622126': { name: 'Discover Bank', country: 'US', type: 'credit', network: 'discover' },
        
        // US Bank
        '451055': { name: 'U.S. Bank', country: 'US', type: 'credit', network: 'visa' },
        '542418': { name: 'U.S. Bank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // PNC Bank
        '451277': { name: 'PNC Bank', country: 'US', type: 'credit', network: 'visa' },
        '541333': { name: 'PNC Bank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // Truist Bank (BB&T/SunTrust)
        '451770': { name: 'Truist Bank', country: 'US', type: 'credit', network: 'visa' },
        '540025': { name: 'Truist Bank', country: 'US', type: 'credit', network: 'mastercard' },
        
        // Navy Federal Credit Union
        '414755': { name: 'Navy Federal Credit Union', country: 'US', type: 'credit', network: 'visa' },
        '542125': { name: 'Navy Federal Credit Union', country: 'US', type: 'credit', network: 'mastercard' }
      };
      
      // Buscar en base de datos local por BIN completo o partial
      const fullBin = bin.substring(0, 6);
      const partialBin = bin.substring(0, 4);
      
      if (usBankDatabase[fullBin]) {
        console.log("Found bank in local database (full BIN):", fullBin);
        bankData.bank = usBankDatabase[fullBin];
        bankData.source = 'local_database_full';
        return bankData;
      } else if (usBankDatabase[partialBin]) {
        console.log("Found bank in local database (partial BIN):", partialBin);
        bankData.bank = usBankDatabase[partialBin];
        bankData.source = 'local_database_partial';
        return bankData;
      }
      
      // 2. Intentar binlist.net como fallback
      try {
        console.log("Trying binlist.net for BIN:", bin);
        const binResponse = await fetch(`https://lookup.binlist.net/${bin}`, {
          headers: {
            'Accept-Version': '3',
            'User-Agent': 'my-radar-validator/1.0'
          },
          timeout: 3000
        });
        
        if (binResponse.ok) {
          const binlistData = await binResponse.json();
          console.log("binlist.net response:", JSON.stringify(binlistData));
          
          bankData.bank = binlistData.bank || null;
          bankData.country = binlistData.country || null;
          bankData.type = binlistData.type || null;
          bankData.scheme = binlistData.scheme || null;
          bankData.prepaid = binlistData.prepaid || null;
          bankData.source = 'binlist.net';
          
          return bankData;
        } else if (binResponse.status === 429) {
          console.log("binlist.net rate limited");
        } else {
          console.log("binlist.net failed:", binResponse.status);
        }
      } catch (binlistError) {
        console.error("binlist.net error:", binlistError.message);
      }
      
      return bankData;
    }
    
    // Intentar lookup si tenemos un BIN
    if (binToLookup) {
      try {
        binInfo = await getBankInfo(binToLookup);
        if (binInfo && binInfo.bank) {
          cardDetails.bin_info = binInfo;
          console.log("Bank info obtained from", binInfo.source, ":", JSON.stringify(binInfo.bank));
        } else {
          console.log("No bank information found for BIN:", binToLookup);
        }
      } catch (error) {
        console.error("Error in bank lookup:", error);
      }
    } else {
      console.log("No BIN/IIN available for lookup");
    }

    console.log("Final card details:", JSON.stringify(cardDetails));

    // Determinar qué tipo de validación usar
    if (validation_type === 'payment') {
      return await handlePaymentIntentValidation(stripe, payment_method_id, cardDetails, headers);
    } else {
      return await handleSetupIntentValidation(stripe, payment_method_id, cardDetails, headers);
    }

  } catch (error) {
    console.error("General function error:", error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message
      })
    };
  }
};

// Función para manejar validación con Setup Intent (Gratuita)
async function handleSetupIntentValidation(stripe, payment_method_id, cardDetails, headers) {
  try {
    console.log("Processing Setup Intent validation");

    const setupIntent = await stripe.setupIntents.create({
      payment_method: payment_method_id,
      confirm: true,
      usage: 'off_session', // Para validación sin presencia del cliente
      metadata: {
        validation_type: 'card_validator_zero_cost',
        source: 'my-radar',
        verification_date: new Date().toISOString(),
        card_brand: cardDetails.brand,
        card_last4: cardDetails.last4,
        require_cvc: 'true'
      },
      payment_method_options: {
        card: {
          request_three_d_secure: 'any' // Forzar 3D Secure que también verifica CVC
        }
      },
      expand: ['payment_method', 'latest_attempt', 'mandate']
    });

    console.log("SetupIntent created:", setupIntent.id, "Status:", setupIntent.status);

    const status = setupIntent.status;
    let success = false;
    let validationDetails = {
      isValid: false,
      reason: 'Sin validación completa',
      validationMethod: 'No completado'
    };

    if (status === 'succeeded') {
      success = true;
      validationDetails = {
        isValid: true,
        reason: 'Tarjeta validada exitosamente sin cargo',
        validationMethod: 'setupIntent.status = succeeded'
      };
    } else if (status === 'processing') {
      success = true;
      validationDetails = {
        isValid: true,
        reason: 'Tarjeta válida - procesando autenticación',
        validationMethod: 'setupIntent.status = processing'
      };
    } else if (status === 'requires_action' || status === 'requires_confirmation') {
      console.log("3D Secure required, client_secret:", setupIntent.client_secret);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: false,
          status: status,
          setup_intent: setupIntent.id,
          client_secret: setupIntent.client_secret,
          requires_action: true,
          isSetupIntent: true
        })
      };
    } else {
      validationDetails = {
        isValid: false,
        reason: `Validación falló: ${status}`,
        validationMethod: 'setupIntent.status analysis'
      };
    }

    // Obtener información COMPLETA del payment method expandido
    const expandedPaymentMethod = setupIntent.payment_method ? 
      (typeof setupIntent.payment_method === 'string' ? 
        await stripe.paymentMethods.retrieve(setupIntent.payment_method) : 
        setupIntent.payment_method) : null;

    const setupDetails = {
      id: setupIntent.id,
      object: setupIntent.object,
      status: setupIntent.status,
      created: setupIntent.created,
      usage: setupIntent.usage,
      payment_method: setupIntent.payment_method,
      payment_method_details: expandedPaymentMethod,
      metadata: setupIntent.metadata || {},
      client_secret: setupIntent.client_secret,
      customer: setupIntent.customer,
      description: setupIntent.description,
      last_setup_error: setupIntent.last_setup_error,
      latest_attempt: setupIntent.latest_attempt,
      livemode: setupIntent.livemode,
      mandate: setupIntent.mandate,
      next_action: setupIntent.next_action,
      on_behalf_of: setupIntent.on_behalf_of,
      payment_method_options: setupIntent.payment_method_options,
      payment_method_types: setupIntent.payment_method_types,
      single_use_mandate: setupIntent.single_use_mandate,
      application: setupIntent.application,
      cancellation_reason: setupIntent.cancellation_reason,
      flow_directions: setupIntent.flow_directions
    };

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: success,
        status: status,
        setup_intent: setupIntent.id,
        card_details: cardDetails,
        setup_details: setupDetails,
        payment_method_details: expandedPaymentMethod,
        charge_info: null,
        validation_details: validationDetails,
        isSetupIntent: true,
        server_timestamp: new Date().toISOString(),
        raw_setup_intent: setupIntent // Incluir el objeto completo para debugging
      })
    };

  } catch (stripeError) {
    console.error("Setup Intent error:", stripeError);
    return handleStripeError(stripeError, cardDetails, headers, 'setup');
  }
}

// Función para manejar validación con Payment Intent (Premium)
async function handlePaymentIntentValidation(stripe, payment_method_id, cardDetails, headers) {
  try {
    console.log("Processing Payment Intent validation");

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 50, // $0.50 USD
      currency: 'usd',
      payment_method: payment_method_id,
      confirm: true,
      capture_method: 'manual',
      metadata: {
        validation_type: 'card_validator_premium',
        source: 'my-radar',
        verification_date: new Date().toISOString(),
        auto_refund: 'true',
        card_brand: cardDetails.brand,
        card_last4: cardDetails.last4
      },
      payment_method_options: {
        card: {
          request_three_d_secure: 'any', // Forzar 3D Secure para verificación adicional
          require_cvc_recollection: true // Requerir CVC incluso para tarjetas guardadas
        }
      },
      statement_descriptor: 'CARD VERIFICATION',
      statement_descriptor_suffix: 'REFUND',
      expand: ['latest_charge', 'payment_method', 'latest_charge.balance_transaction']
    });

    console.log("PaymentIntent created:", paymentIntent.id, "Status:", paymentIntent.status);

    const status = paymentIntent.status;
    let success = false;
    let validationDetails = {
      isValid: false,
      reason: 'Sin validación completa',
      validationMethod: 'No completado'
    };

    if (status === 'requires_action' || status === 'requires_source_action') {
      console.log("3D Secure required, client_secret:", paymentIntent.client_secret);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: false,
          status: status,
          payment_intent: paymentIntent.id,
          client_secret: paymentIntent.client_secret,
          requires_action: true,
          isPaymentIntent: true
        })
      };
    }

    // Verificar el resultado del cargo
    if (paymentIntent.latest_charge) {
      try {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        console.log("Charge details:", JSON.stringify(charge, null, 2));

        if (charge.outcome && charge.outcome.type === 'authorized' && charge.paid === true) {
          success = true;
          validationDetails = {
            isValid: true,
            reason: 'Autorización exitosa y pago confirmado',
            validationMethod: 'charge.outcome + charge.paid'
          };
        } else if (charge.status === 'succeeded' && charge.paid === true) {
          success = true;
          validationDetails = {
            isValid: true,
            reason: 'Estado de cargo exitoso y pago confirmado',
            validationMethod: 'charge.status + charge.paid'
          };
        } else {
          success = false;
          let reason = 'Falló la autorización';
          if (charge.outcome) {
            if (charge.outcome.type === 'issuer_declined') {
              reason = 'Rechazada por el banco emisor';
            } else if (charge.outcome.type === 'blocked') {
              reason = 'Bloqueada por reglas de seguridad';
            } else if (charge.outcome.network_status === 'declined_by_network') {
              reason = 'Rechazada por la red de procesamiento';
            } else {
              reason = `Resultado: ${charge.outcome.type || 'desconocido'}`;
            }
          }
          validationDetails = {
            isValid: false,
            reason: reason,
            validationMethod: 'charge.outcome análisis detallado'
          };
        }
      } catch (chargeError) {
        console.error("Error retrieving charge details:", chargeError);
        success = false;
        validationDetails = {
          isValid: false,
          reason: 'Error al recuperar detalles del cargo',
          validationMethod: 'error handling'
        };
      }
    } else if (status === 'succeeded') {
      success = true;
      validationDetails = {
        isValid: true,
        reason: 'PaymentIntent exitoso',
        validationMethod: 'paymentIntent.status'
      };
    }

    // Si fue exitoso, crear reembolso automático
    if (success && status === 'succeeded') {
      console.log("Payment succeeded, creating refund for:", paymentIntent.id);
      try {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntent.id,
          reason: 'requested_by_customer',
          metadata: {
            validation_purpose: 'card_validator_automatic_refund',
            source: 'my-radar'
          }
        });
        console.log("Refund created successfully:", refund.id);
      } catch (refundError) {
        console.error("Error creating refund:", refundError);
      }
    }

    // Información COMPLETA del cargo con TODOS los campos disponibles de la API
    let chargeInfo = null;
    if (paymentIntent.latest_charge) {
      try {
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge, {
          expand: ['balance_transaction', 'payment_method_details', 'billing_details']
        });
        chargeInfo = {
          // Información básica del cargo
          id: charge.id,
          object: charge.object,
          status: charge.status,
          created: charge.created,
          paid: charge.paid,
          amount: charge.amount,
          amount_captured: charge.amount_captured,
          amount_refunded: charge.amount_refunded,
          currency: charge.currency,
          captured: charge.captured,
          refunded: charge.refunded,
          
          // Información de la transacción de balance
          balance_transaction: charge.balance_transaction,
          
          // Información completa del outcome (análisis de riesgo)
          outcome: charge.outcome ? {
            type: charge.outcome.type,
            network_status: charge.outcome.network_status,
            risk_level: charge.outcome.risk_level,
            risk_score: charge.outcome.risk_score,
            seller_message: charge.outcome.seller_message,
            reason: charge.outcome.reason
          } : null,
          
          // Detalles completos del método de pago usado en el cargo
          payment_method_details: charge.payment_method_details ? {
            type: charge.payment_method_details.type,
            card: charge.payment_method_details.card ? {
              brand: charge.payment_method_details.card.brand,
              checks: charge.payment_method_details.card.checks,
              country: charge.payment_method_details.card.country,
              exp_month: charge.payment_method_details.card.exp_month,
              exp_year: charge.payment_method_details.card.exp_year,
              fingerprint: charge.payment_method_details.card.fingerprint,
              funding: charge.payment_method_details.card.funding,
              installments: charge.payment_method_details.card.installments,
              last4: charge.payment_method_details.card.last4,
              network: charge.payment_method_details.card.network,
              three_d_secure: charge.payment_method_details.card.three_d_secure,
              wallet: charge.payment_method_details.card.wallet
            } : null
          } : null,
          
          // Información de billing
          billing_details: charge.billing_details,
          
          // Información de descripción y statement
          calculated_statement_descriptor: charge.calculated_statement_descriptor,
          statement_descriptor: charge.statement_descriptor,
          statement_descriptor_suffix: charge.statement_descriptor_suffix,
          description: charge.description,
          
          // Información de estado y disputas
          disputed: charge.disputed,
          failure_code: charge.failure_code,
          failure_message: charge.failure_message,
          
          // Información de fraud details (si está disponible)
          fraud_details: charge.fraud_details,
          
          // Información de la factura y customer
          invoice: charge.invoice,
          customer: charge.customer,
          
          // Información de transferencia
          transfer_data: charge.transfer_data,
          transfer_group: charge.transfer_group,
          
          // Información de reembolsos
          refunds: charge.refunds,
          
          // Información adicional
          livemode: charge.livemode,
          metadata: charge.metadata,
          receipt_email: charge.receipt_email,
          receipt_number: charge.receipt_number,
          receipt_url: charge.receipt_url,
          review: charge.review,
          shipping: charge.shipping,
          source_transfer: charge.source_transfer,
          application: charge.application,
          application_fee: charge.application_fee,
          application_fee_amount: charge.application_fee_amount
        };
      } catch (chargeError) {
        console.error("Error retrieving charge details for response:", chargeError);
      }
    }

    // Obtener información COMPLETA del payment method expandido para PaymentIntent
    const expandedPaymentMethod = paymentIntent.payment_method ? 
      (typeof paymentIntent.payment_method === 'string' ? 
        await stripe.paymentMethods.retrieve(paymentIntent.payment_method) : 
        paymentIntent.payment_method) : null;

    const paymentDetails = {
      id: paymentIntent.id,
      object: paymentIntent.object,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      amount_capturable: paymentIntent.amount_capturable,
      amount_details: paymentIntent.amount_details,
      amount_received: paymentIntent.amount_received,
      application: paymentIntent.application,
      application_fee_amount: paymentIntent.application_fee_amount,
      automatic_payment_methods: paymentIntent.automatic_payment_methods,
      canceled_at: paymentIntent.canceled_at,
      cancellation_reason: paymentIntent.cancellation_reason,
      capture_method: paymentIntent.capture_method,
      client_secret: paymentIntent.client_secret,
      confirmation_method: paymentIntent.confirmation_method,
      created: paymentIntent.created,
      currency: paymentIntent.currency,
      customer: paymentIntent.customer,
      description: paymentIntent.description,
      invoice: paymentIntent.invoice,
      last_payment_error: paymentIntent.last_payment_error,
      latest_charge: paymentIntent.latest_charge,
      livemode: paymentIntent.livemode,
      metadata: paymentIntent.metadata || {},
      next_action: paymentIntent.next_action,
      on_behalf_of: paymentIntent.on_behalf_of,
      payment_method: paymentIntent.payment_method,
      payment_method_configuration_details: paymentIntent.payment_method_configuration_details,
      payment_method_options: paymentIntent.payment_method_options,
      payment_method_types: paymentIntent.payment_method_types,
      processing: paymentIntent.processing,
      receipt_email: paymentIntent.receipt_email,
      review: paymentIntent.review,
      setup_future_usage: paymentIntent.setup_future_usage,
      shipping: paymentIntent.shipping,
      statement_descriptor: paymentIntent.statement_descriptor,
      statement_descriptor_suffix: paymentIntent.statement_descriptor_suffix,
      status: paymentIntent.status,
      transfer_data: paymentIntent.transfer_data,
      transfer_group: paymentIntent.transfer_group
    };

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: success,
        status: status,
        payment_intent: paymentIntent.id,
        card_details: cardDetails,
        payment_details: paymentDetails,
        payment_method_details: expandedPaymentMethod,
        charge_info: chargeInfo,
        validation_details: validationDetails,
        isPaymentIntent: true,
        server_timestamp: new Date().toISOString(),
        raw_payment_intent: paymentIntent // Incluir el objeto completo para debugging
      })
    };

  } catch (stripeError) {
    console.error("Payment Intent error:", stripeError);
    return handleStripeError(stripeError, cardDetails, headers, 'payment');
  }
}

// Función para manejar errores de Stripe
function handleStripeError(stripeError, cardDetails, headers, validationType) {
  let errorDetails = {
    type: stripeError.type,
    code: stripeError.code,
    decline_code: stripeError.decline_code,
    message: stripeError.message,
    param: stripeError.param,
    charge: stripeError.charge,
    payment_intent: stripeError.payment_intent,
    setup_intent: stripeError.setup_intent,
    source: stripeError.source
  };

  if (stripeError.raw) {
    if (stripeError.raw.network_decline_code) errorDetails.network_decline_code = stripeError.raw.network_decline_code;
    if (stripeError.raw.network_advice_code) errorDetails.network_advice_code = stripeError.raw.network_advice_code;
    if (stripeError.raw.advice_code) errorDetails.advice_code = stripeError.raw.advice_code;
  }

  // Mapear códigos de error a mensajes más descriptivos
  let detailedReason = stripeError.message;
  let userFriendlyReason = '';
  
  switch(stripeError.code) {
    case 'card_declined':
      userFriendlyReason = 'Tarjeta rechazada por el banco emisor';
      if (stripeError.decline_code) {
        switch(stripeError.decline_code) {
          case 'insufficient_funds':
            detailedReason = 'Fondos insuficientes en la cuenta';
            break;
          case 'stolen_card':
            detailedReason = 'Tarjeta reportada como robada';
            break;
          case 'lost_card':
            detailedReason = 'Tarjeta reportada como perdida';
            break;
          case 'pickup_card':
            detailedReason = 'Tarjeta debe ser retenida - contacte al banco';
            break;
          case 'restricted_card':
            detailedReason = 'Tarjeta tiene restricciones para este tipo de transacción';
            break;
          case 'security_violation':
            detailedReason = 'Violación de seguridad detectada';
            break;
          case 'service_not_allowed':
            detailedReason = 'Servicio no permitido para esta tarjeta';
            break;
          case 'transaction_not_allowed':
            detailedReason = 'Tipo de transacción no permitida';
            break;
          case 'try_again_later':
            detailedReason = 'Error temporal - intente nuevamente más tarde';
            break;
          case 'incorrect_number':
            detailedReason = 'Número de tarjeta incorrecto';
            break;
          case 'incorrect_cvc':
            detailedReason = 'Código CVC incorrecto';
            break;
          case 'incorrect_zip':
            detailedReason = 'Código postal incorrecto';
            break;
          case 'expired_card':
            detailedReason = 'Tarjeta expirada';
            break;
          case 'processing_error':
            detailedReason = 'Error de procesamiento en el banco';
            break;
          case 'issuer_not_available':
            detailedReason = 'Banco emisor no disponible temporalmente';
            break;
          default:
            detailedReason = `Declinada: ${stripeError.decline_code}`;
        }
      }
      break;
    case 'incorrect_cvc':
      userFriendlyReason = 'Código CVC/CVV incorrecto';
      detailedReason = 'El código de seguridad de 3 dígitos es incorrecto';
      break;
    case 'expired_card':
      userFriendlyReason = 'Tarjeta expirada';
      detailedReason = 'La fecha de expiración de la tarjeta ha pasado';
      break;
    case 'incorrect_number':
      userFriendlyReason = 'Número de tarjeta inválido';
      detailedReason = 'El número de tarjeta ingresado no es válido';
      break;
    case 'authentication_required':
      userFriendlyReason = 'Autenticación 3D Secure requerida';
      detailedReason = 'La tarjeta requiere autenticación adicional del cliente';
      break;
    case 'currency_not_supported':
      userFriendlyReason = 'Moneda no soportada';
      detailedReason = 'La tarjeta no soporta la moneda USD';
      break;
  }

  const errorResponse = {
    success: false,
    error: stripeError.message,
    user_friendly_reason: userFriendlyReason,
    detailed_reason: detailedReason,
    type: stripeError.type || 'stripe_error',
    code: stripeError.code || 'unknown',
    decline_code: stripeError.decline_code || null,
    validation_type: validationType,
    validation_details: {
      isValid: false,
      reason: detailedReason,
      validationMethod: `Error: ${stripeError.type || 'stripe_error'}`
    },
    error_details: errorDetails,
    server_timestamp: new Date().toISOString()
  };

  if (cardDetails && cardDetails !== 'No card details available') {
    errorResponse.card_details = cardDetails;
  }

  return {
    statusCode: 200, // Cambiar a 200 para que el frontend maneje como resultado normal
    headers: headers,
    body: JSON.stringify(errorResponse)
  };
}