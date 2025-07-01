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
    const validation_type = data.validation_type || 'setup'; // Default to setup intent
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

    // Crear un SetupIntent
    console.log("Creating SetupIntent with payment method:", payment_method_id);
    
    // Variable para almacenar los detalles del método de pago - declarada fuera del try-catch
    let paymentMethod = null;
    
    try {
      if (validation_type === 'payment') {
        // Validación Premium con Payment Intent
        console.log("Creating payment intent for premium validation with payment method:", payment_method_id);
        return await handlePaymentIntentValidation(stripe, payment_method_id, paymentMethod, headers);
      } else {
        // Validación Gratuita con Setup Intent (default)
        console.log("Creating setup intent for free validation with payment method:", payment_method_id);
        return await handleSetupIntentValidation(stripe, payment_method_id, paymentMethod, headers);
      }
    } catch (error) {
      // Error general no relacionado con Stripe
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
  }
};

// Función para manejar validación con Setup Intent (Gratuita)
async function handleSetupIntentValidation(stripe, payment_method_id, paymentMethod, headers) {
  try {
      
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
      
      console.log("Card details:", JSON.stringify(cardDetails));
      
      // Crear un SetupIntent para validación sin cargo
      const setupIntent = await stripe.setupIntents.create({
        payment_method: payment_method_id,
        confirm: true, // Confirmar inmediatamente
        usage: 'off_session', // Para validación pura sin necesidad de presencia del cliente
        metadata: {
          validation_type: 'card_validator_zero_cost',
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
        }
      });
      
      console.log("SetupIntent created:", setupIntent.id, "Status:", setupIntent.status);
      
      // Verificar el estado
      const status = setupIntent.status;
      
      // Inicialmente asumimos que no es válida
      let success = false;
      let validationDetails = {
        isValid: false,
        reason: 'Sin validación completa',
        validationMethod: 'No completado'
      };
      
      // Verificar el resultado del SetupIntent para confirmar que la tarjeta es válida
      if (status === 'succeeded') {
        // SetupIntent exitoso significa que la tarjeta es válida
        success = true;
        validationDetails = {
          isValid: true,
          reason: 'Tarjeta validada exitosamente sin cargo',
          validationMethod: 'setupIntent.status = succeeded'
        };
        console.log("Setup Intent succeeded - card is valid");
      } else if (status === 'processing') {
        // Aún en proceso - consideramos válida pero en proceso
        success = true;
        validationDetails = {
          isValid: true,
          reason: 'Tarjeta válida - procesando autenticación',
          validationMethod: 'setupIntent.status = processing'
        };
        console.log("Setup Intent processing - card appears valid");
      } else {
        // Cualquier otro estado indica problemas
        success = false;
        validationDetails = {
          isValid: false,
          reason: `Validación falló: ${status}`,
          validationMethod: 'setupIntent.status analysis'
        };
        console.log("Setup Intent failed with status:", status);
      }

      // Si se requiere autenticación 3D Secure
      if (status === 'requires_action' || status === 'requires_confirmation') {
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
            isSetupIntent: true  // Flag para que el frontend sepa que es SetupIntent
          })
        };
      }
      
      // Con SetupIntent no hay cargos, por lo que no necesitamos reembolsos
      if (status === 'succeeded') {
        console.log("Setup Intent succeeded - no charges made, no refunds needed");
      }

      // Extraer detalles del SetupIntent
      const setupDetails = {
        id: setupIntent.id,
        status: setupIntent.status,
        created: setupIntent.created,
        usage: setupIntent.usage,
        payment_method: setupIntent.payment_method,
        metadata: setupIntent.metadata || {},
        client_secret: setupIntent.client_secret
      };

      // Con SetupIntent no hay cargos asociados
      let chargeInfo = null; // No aplica para SetupIntent

      console.log("Returning response with extended details, validation status:", success);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: success,
          status: status,
          setup_intent: setupIntent.id,
          card_details: cardDetails,
          setup_details: setupDetails,
          charge_info: chargeInfo, // null para SetupIntent
          validation_details: validationDetails,
          isSetupIntent: true,
          server_timestamp: new Date().toISOString()
        })
      };
    } catch (stripeError) {
      console.error("Stripe API error:", stripeError);
      
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
        console.log("Raw error object available:", stripeError.raw);
        
        // Añadir códigos detallados de la red si están disponibles
        if (stripeError.raw.network_decline_code) errorDetails.network_decline_code = stripeError.raw.network_decline_code;
        if (stripeError.raw.network_advice_code) errorDetails.network_advice_code = stripeError.raw.network_advice_code;
        if (stripeError.raw.advice_code) errorDetails.advice_code = stripeError.raw.advice_code;
      }
      
      // Intentar obtener detalles del error del setupIntent.last_setup_error si existe
      if (stripeError.setup_intent && stripeError.setup_intent.last_setup_error) {
        const lastError = stripeError.setup_intent.last_setup_error;
        console.log("Last setup error available:", lastError);
        
        // Añadir códigos detallados si están disponibles
        if (lastError.network_decline_code) errorDetails.network_decline_code = lastError.network_decline_code;
        if (lastError.network_advice_code) errorDetails.network_advice_code = lastError.network_advice_code;
        if (lastError.advice_code) errorDetails.advice_code = lastError.advice_code;
        if (lastError.doc_url) errorDetails.doc_url = lastError.doc_url;
      }
      
      console.log("Complete error details:", errorDetails);
      
      // Enviar información de error al webhook para notificaciones
      try {
        // Crear un evento personalizado para el error de validación (sólo para logs)
        await stripe.events.create(
          {
            type: 'card_validation_error_setup',
            data: {
              object: {
                error_type: stripeError.type || 'unknown_error',
                error_code: stripeError.code || 'unknown',
                decline_code: stripeError.decline_code || 'unknown',
                message: stripeError.message,
                timestamp: new Date().toISOString(),
                validator: 'my-radar-setup-intent',
                method: 'setup_intent_validation'
              }
            }
          },
          {
            stripeAccount: null
          }
        );
      } catch (err) {
        console.error("Failed to create custom event log:", err);
        // No interrumpimos el flujo si esto falla
      }
      
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
        setup_intent: stripeError.setup_intent || null
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
