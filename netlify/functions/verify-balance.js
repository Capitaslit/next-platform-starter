// Importar Stripe directamente
const Stripe = require('stripe');

exports.handler = async function(event, context) {
  // Inicializar Stripe con la clave secreta
  const stripe = Stripe('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', {
    apiVersion: '2020-08-27', // Especificar una versión fija de la API
    maxNetworkRetries: 3      // Configurar reintentos automáticos
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
    console.log("Request body (balance check):", event.body);
    
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
    console.log("Payment method ID (balance check):", payment_method_id);

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

    // Variable para almacenar los detalles del método de pago - declarada fuera del try-catch
    let paymentMethod = null;
    
    try {
      // Creamos un PaymentIntent por $50 USD para verificar el saldo
      console.log("Creating payment intent for $50 balance check with payment method:", payment_method_id);
      
      // Obtenemos los detalles del método de pago primero
      paymentMethod = await stripe.paymentMethods.retrieve(payment_method_id);
      
      // Extraemos todos los detalles de la tarjeta para logs
      const cardDetails = paymentMethod.card ? {
        brand: paymentMethod.card.brand,
        last4: paymentMethod.card.last4,
        exp_month: paymentMethod.card.exp_month,
        exp_year: paymentMethod.card.exp_year,
        country: paymentMethod.card.country,
        funding: paymentMethod.card.funding || 'unknown',
        fingerprint: paymentMethod.card.fingerprint || 'unknown',
        checks: paymentMethod.card.checks || {},
        networks: paymentMethod.card.networks || {},
        three_d_secure_usage: paymentMethod.card.three_d_secure_usage || {},
        wallet: paymentMethod.card.wallet ? paymentMethod.card.wallet.type : null
      } : 'No card details available';
      
      console.log("Card details (balance check):", JSON.stringify(cardDetails));
      
      // Crear un PaymentIntent por $50 USD
      const paymentIntent = await stripe.paymentIntents.create({
        amount: 5000, // $50.00 USD
        currency: 'usd',
        payment_method: payment_method_id,
        confirm: true, // Confirmar inmediatamente
        capture_method: 'manual', // Para permitir autorización sin captura
        metadata: {
          validation_type: 'balance_check',
          source: 'my-radar',
          verification_date: new Date().toISOString(),
          card_brand: cardDetails.brand,
          card_last4: cardDetails.last4
        },
        // Habilitar opciones avanzadas para obtener más información
        payment_method_options: {
          card: {
            request_three_d_secure: 'automatic'
          }
        },
        // Ajustamos el statement descriptor para que el cliente sepa que es una verificación
        statement_descriptor: 'BALANCE CHECK',
        statement_descriptor_suffix: 'NO CHARGE'
      });
      
      console.log("PaymentIntent created (balance check):", paymentIntent.id, "Status:", paymentIntent.status);
      
      // Extraer detalles adicionales que puedan ser relevantes para el usuario
      const paymentDetails = {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        created: paymentIntent.created,
        capture_method: paymentIntent.capture_method,
        statement_descriptor: paymentIntent.statement_descriptor,
        latest_charge: paymentIntent.latest_charge,
        payment_method: paymentIntent.payment_method,
        metadata: paymentIntent.metadata || {}
      };

      // Información sobre el cargo asociado si está disponible
      let chargeInfo = null;
      if (paymentIntent.latest_charge) {
        try {
          const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
          chargeInfo = {
            id: charge.id,
            status: charge.status,
            outcome: charge.outcome,
            risk_level: charge.outcome ? charge.outcome.risk_level : null,
            risk_score: charge.outcome ? charge.outcome.risk_score : null,
            created: charge.created,
            paid: charge.paid,
            amount: charge.amount,
            currency: charge.currency,
            payment_method_details: charge.payment_method_details,
            risk_data: {
              risk_level: charge.outcome ? charge.outcome.risk_level : null,
              risk_score: charge.outcome ? charge.outcome.risk_score : null,
              rule_name: charge.outcome && charge.outcome.rule ? charge.outcome.rule.name : null,
              rule_id: charge.outcome && charge.outcome.rule ? charge.outcome.rule.id : null,
              radar_options: charge.radar_options || null,
              fraud_details: charge.fraud_details || null,
              outcome_type: charge.outcome ? charge.outcome.type : null,
              network_risk_score: charge.outcome ? charge.outcome.network_score : null
            }
          };
        } catch (chargeError) {
          console.error("Error retrieving charge details (balance check):", chargeError);
          // Si hay un error, continuamos sin los detalles del cargo
        }
      }
      
      // Verificar el estado
      const status = paymentIntent.status;
      const success = ['succeeded', 'requires_capture', 'processing'].includes(status);
      
      // Determinar el estado del saldo basado en la respuesta
      let balanceStatus = 'unknown';
      let balanceMessage = '';
      
      // Si la transacción fue autorizada, significa que hay saldo suficiente
      if (status === 'requires_capture') {
        balanceStatus = 'sufficient';
        balanceMessage = 'La tarjeta tiene saldo suficiente (al menos $50 USD).';
      } 
      // Si hay un error que indica fondos insuficientes
      else if (paymentIntent.last_payment_error && 
               (paymentIntent.last_payment_error.code === 'insufficient_funds' || 
                paymentIntent.last_payment_error.decline_code === 'insufficient_funds')) {
        balanceStatus = 'insufficient';
        balanceMessage = 'La tarjeta no tiene fondos suficientes para $50 USD.';
      }
      // Cualquier otro estado
      else {
        balanceStatus = status;
        balanceMessage = `Resultado de verificación: ${status}`;
      }

      // Si necesita autenticación 3D Secure
      if (status === 'requires_action' || status === 'requires_source_action') {
        console.log("3D Secure required for balance check, client_secret:", paymentIntent.client_secret);
        return {
          statusCode: 200,
          headers: headers,
          body: JSON.stringify({
            success: false,
            status: status,
            payment_intent: paymentIntent.id,
            client_secret: paymentIntent.client_secret,
            requires_action: true,
            isPaymentIntent: true,
            balanceCheck: true,
            balanceStatus: 'needs_auth'
          })
        };
      }
      
      // Cancelar el PaymentIntent ya que solo estamos verificando el saldo
      try {
        if (status === 'requires_capture') {
          console.log("Canceling payment intent after successful balance check:", paymentIntent.id);
          await stripe.paymentIntents.cancel(paymentIntent.id, {
            cancellation_reason: 'requested_by_customer',
            metadata: {
              balance_check_result: 'sufficient',
              canceled_at: new Date().toISOString()
            }
          });
          console.log("Successfully canceled payment intent after balance check");
        }
      } catch (cancelError) {
        console.error("Error canceling payment intent after balance check:", cancelError);
        // No fallamos la operación aunque haya un error en la cancelación
      }

      console.log("Returning balance check response with status:", balanceStatus);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: success,
          status: status,
          payment_intent: paymentIntent.id,
          card_details: cardDetails,
          payment_details: paymentDetails,
          charge_info: chargeInfo,
          balanceCheck: true,
          balanceStatus: balanceStatus,
          balanceMessage: balanceMessage,
          server_timestamp: new Date().toISOString()
        })
      };
    } catch (stripeError) {
      console.error("Stripe API error during balance check:", stripeError);
      
      // Procesamos el error y determinamos si está relacionado con fondos insuficientes
      let balanceStatus = 'error';
      let balanceMessage = '';
      
      // Verificar si el error está relacionado con fondos insuficientes
      if (stripeError.code === 'card_declined' && 
          stripeError.decline_code === 'insufficient_funds') {
        balanceStatus = 'insufficient';
        balanceMessage = 'La tarjeta no tiene fondos suficientes para $50 USD.';
      } else {
        balanceStatus = 'error';
        balanceMessage = stripeError.message || 'Error al verificar el saldo';
      }
      
      // Intentar obtener la información completa del error
      let errorDetails = {
        type: stripeError.type,
        code: stripeError.code,
        decline_code: stripeError.decline_code,
        message: stripeError.message,
        param: stripeError.param
      };
      
      // Acceder a más detalles si está disponible el objeto raw
      if (stripeError.raw) {
        console.log("Raw error object available (balance check):", stripeError.raw);
        
        // Añadir códigos detallados de la red si están disponibles
        if (stripeError.raw.network_decline_code) errorDetails.network_decline_code = stripeError.raw.network_decline_code;
        if (stripeError.raw.network_advice_code) errorDetails.network_advice_code = stripeError.raw.network_advice_code;
        if (stripeError.raw.advice_code) errorDetails.advice_code = stripeError.raw.advice_code;
      }
      
      // Intentar obtener detalles del error del paymentIntent.last_payment_error si existe
      if (stripeError.payment_intent && stripeError.payment_intent.last_payment_error) {
        const lastError = stripeError.payment_intent.last_payment_error;
        console.log("Last payment error available (balance check):", lastError);
        
        // Añadir códigos detallados si están disponibles
        if (lastError.network_decline_code) errorDetails.network_decline_code = lastError.network_decline_code;
        if (lastError.network_advice_code) errorDetails.network_advice_code = lastError.network_advice_code;
        if (lastError.advice_code) errorDetails.advice_code = lastError.advice_code;
        if (lastError.doc_url) errorDetails.doc_url = lastError.doc_url;
        
        // Verificar específicamente si hay un código de fondos insuficientes
        if (lastError.code === 'insufficient_funds' || lastError.decline_code === 'insufficient_funds') {
          balanceStatus = 'insufficient';
          balanceMessage = 'La tarjeta no tiene fondos suficientes para $50 USD.';
        }
      }
      
      console.log("Complete error details (balance check):", errorDetails);
      
      // Obtener todos los detalles posibles del error de Stripe
      const errorResponse = {
        error: stripeError.message,
        type: stripeError.type || 'stripe_error',
        code: stripeError.code || 'unknown',
        decline_code: stripeError.decline_code || null,
        network_decline_code: errorDetails.network_decline_code || null,
        network_advice_code: errorDetails.network_advice_code || null,
        advice_code: errorDetails.advice_code || null,
        doc_url: errorDetails.doc_url || null,
        param: stripeError.param || null,
        payment_method_type: stripeError.payment_method_type || null,
        fraud_risk: stripeError.fraud_details ? 'high' : 'unknown',
        charge: stripeError.charge || null,
        balanceCheck: true,
        balanceStatus: balanceStatus,
        balanceMessage: balanceMessage
      };
      
      // Agregar más detalles de la tarjeta si están disponibles
      if (paymentMethod && paymentMethod.card) {
        errorResponse.card_details = {
          brand: paymentMethod.card.brand,
          last4: paymentMethod.card.last4,
          exp_month: paymentMethod.card.exp_month,
          exp_year: paymentMethod.card.exp_year,
          country: paymentMethod.card.country,
          funding: paymentMethod.card.funding,
          fingerprint: paymentMethod.card.fingerprint,
          checks: paymentMethod.card.checks || {},
          wallet: paymentMethod.card.wallet ? paymentMethod.card.wallet.type : null
        };
      }
      
      // Proporcionar mensaje más detallado sobre la declinación
      if (stripeError.decline_code) {
        const declineMessages = {
          'generic_decline': 'La tarjeta fue rechazada por el banco sin un motivo específico.',
          'insufficient_funds': 'La tarjeta no tiene fondos suficientes para completar la transacción.',
          'lost_card': 'Esta tarjeta ha sido reportada como perdida.',
          'stolen_card': 'Esta tarjeta ha sido reportada como robada.',
          'expired_card': 'Esta tarjeta ha expirado.',
          'incorrect_number': 'El número de tarjeta es incorrecto.',
          'invalid_expiry_month': 'El mes de expiración es inválido.',
          'invalid_expiry_year': 'El año de expiración es inválido.',
          'invalid_cvc': 'El código de seguridad CVC/CVV es inválido.',
          'incorrect_cvc': 'El código de seguridad CVC/CVV es incorrecto.',
          'incorrect_zip': 'El código postal no coincide con los registros del banco.',
          'card_velocity_exceeded': 'Se ha excedido el límite de actividad de la tarjeta.',
          'withdrawal_count_limit_exceeded': 'Se ha excedido el límite de retiros.',
          'currency_not_supported': 'La tarjeta no acepta la moneda especificada.',
          'restricted_card': 'La tarjeta tiene restricciones de uso.',
          'security_violation': 'Violación de seguridad detectada.',
          'suspected_fraud': 'La transacción fue marcada como potencialmente fraudulenta.',
          'card_not_supported': 'La tarjeta no es compatible con este tipo de compra.',
          'offline_pin_required': 'Se requiere PIN offline.',
          'approval_expired': 'La aprobación ha expirado.',
          'authentication_required': 'Se requiere autenticación adicional.',
          'call_issuer': 'El emisor de la tarjeta solicita contacto.',
          'pickup_card': 'La tarjeta debe ser retenida.',
          'test_mode_live_card': 'No se puede usar una tarjeta real en modo de prueba.'
        };
        
        errorResponse.decline_reason = declineMessages[stripeError.decline_code] || 'Razón de rechazo desconocida';
      }
      
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify(errorResponse)
      };
    }
  } catch (error) {
    // Error general no relacionado con Stripe
    console.error("General function error (balance check):", error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message,
        balanceCheck: true,
        balanceStatus: 'error'
      })
    };
  }
};
