/* Brew & Bites Cafe — menu data & config.
   Edit CAFE.upiId to your real merchant UPI ID (e.g. name@okhdfcbank)
   to enable real UPI app payments instead of the simulation. */

const CAFE = {
  name: "Brew & Bites Cafe",
  tagline: "Order. Sip. Pay.",
  // Merchant UPI details — used for the "Open UPI App" deep link and the QR code
  // IMPORTANT: "brewandbites@upi" is a PLACEHOLDER — it is NOT a registered VPA,
  // so real UPI apps (GPay/PhonePe/Paytm) will reject it with
  // "something went wrong, please try again later".
  // Replace it with YOUR real UPI ID before going live:
  //   - Personal: the VPA shown in your bank's UPI app (e.g. name@okhdfcbank, name@oksbi)
  //   - Business: a merchant VPA from your bank or a PSP (Razorpay/Cashfree/PhonePe PG)
  upiId: "9900905159@ybl",
  upiName: "Brew & Bites Cafe",
  gstRate: 0.05,          // 5% GST
  adminPasscode: "1234",  // admin dashboard passcode (demo)
  tables: 12,             // number of tables for auto-assignment
  // OTP delivery:
  //  mode "demo"     → OTP shown on screen (no SMS; for testing)
  //  mode "firebase" → real SMS OTP via Firebase Phone Auth. Requires:
  //    a) Firebase project with Authentication → Phone sign-in enabled
  //    b) Billing (Blaze) enabled on the project (phone auth SMS is paid)
  //    c) Web-app config pasted below (Firebase Console → Project settings
  //       → Your apps → Web app → SDK setup and configuration)
  //    d) Your deployed domain added to Authentication → Settings →
  //       Authorized domains (e.g. https://your-app.onrender.com)
  otp: {
    mode: "firebase", // "demo" | "firebase" — firebase sends real SMS via Firebase Phone Auth
    firebaseConfig: {
      apiKey: "AIzaSyD3V9mjOe_bLqpqEwmevrbvKgdNATC6IWs",
      authDomain: "cafee-bee.firebaseapp.com",
      projectId: "cafee-bee",
      appId: "1:167940020266:web:29f2d435730ea1ff630b53"
    }
  },
  // REAL-TIME sync (optional, zero backend):
  // 1. Create a free Firebase project → Realtime Database (start in test mode)
  // 2. Copy the database URL, e.g. https://my-cafe-12345-default-rtdb.firebaseio.com
  // 3. Set enabled: true and paste the URL below.
  // Payments are then mirrored to Firebase and the admin dashboard (on ANY
  // device) updates live via Firebase's realtime stream. Keep enabled: false
  // to stay in pure local demo mode.
  rt: {
    enabled: false,
    url: "" // e.g. "https://my-cafe-12345-default-rtdb.firebaseio.com"
  }
};

const MENU = {
  coffee: {
    name: "Coffee",
    icon: "&#9749;",
    items: [
      { id: "espresso",    name: "Espresso",            desc: "Double shot, bold & intense",           price: 120, emoji: "&#9749;", veg: true },
      { id: "cappuccino",  name: "Cappuccino",          desc: "Classic frothy milk & rich crema",      price: 150, emoji: "&#9749;", veg: true },
      { id: "latte",       name: "Café Latte",          desc: "Silky steamed milk over espresso",      price: 160, emoji: "&#9749;", veg: true },
      { id: "filter",      name: "Filter Coffee",       desc: "South Indian style, chicory blend",     price: 100, emoji: "&#9749;", veg: true },
      { id: "mocha",       name: "Mocha",               desc: "Espresso with dark chocolate",          price: 170, emoji: "&#9749;", veg: true },
      { id: "coldcoffee",  name: "Cold Coffee",         desc: "Blended with vanilla ice cream",        price: 180, emoji: "&#129346;", veg: true }
    ]
  },
  tea: {
    name: "Tea",
    icon: "&#127861;",
    items: [
      { id: "masalachai",  name: "Masala Chai",         desc: "Spiced, brewed with milk",              price: 80,  emoji: "&#127861;", veg: true },
      { id: "ginger",      name: "Ginger Lemon Tea",    desc: "Zingy ginger with a citrus kick",       price: 90,  emoji: "&#127861;", veg: true },
      { id: "greentea",    name: "Green Tea",           desc: "Loose-leaf, light & refreshing",        price: 90,  emoji: "&#127861;", veg: true },
      { id: "icedtea",     name: "Iced Tea",            desc: "Chilled peach iced tea",                price: 120, emoji: "&#129380;", veg: true }
    ]
  },
  snacks: {
    name: "Snacks",
    icon: "&#127839;",
    items: [
      { id: "sandwich",    name: "Grilled Sandwich",    desc: "Veggies, cheese, mint chutney",         price: 120, emoji: "&#129386;", veg: true },
      { id: "garlictoast", name: "Cheese Garlic Toast", desc: "Crispy, buttery, garlicky",             price: 130, emoji: "&#129347;", veg: true },
      { id: "fries",       name: "Peri Peri Fries",     desc: "Crispy fries tossed in peri peri",      price: 110, emoji: "&#127839;", veg: true },
      { id: "burger",      name: "Veg Burger",          desc: "Aloo tikki, cheese, house sauce",       price: 160, emoji: "&#127828;", veg: true },
      { id: "wrap",        name: "Paneer Tikka Wrap",   desc: "Charred paneer in a soft wrap",         price: 170, emoji: "&#127790;", veg: true },
      { id: "maggi",       name: "Masala Maggi",        desc: "The cafe favourite, loaded",            price: 90,  emoji: "&#127837;", veg: true }
    ]
  },
  desserts: {
    name: "Desserts",
    icon: "&#127856;",
    items: [
      { id: "brownie",     name: "Walnut Brownie",      desc: "Warm, gooey, with ice cream option",    price: 140, emoji: "&#127849;", veg: true },
      { id: "cheesecake",  name: "Blueberry Cheesecake",desc: "Baked, creamy, tangy topping",          price: 180, emoji: "&#127856;", veg: true },
      { id: "mousse",      name: "Belgian Choco Mousse",desc: "Silky dark chocolate indulgence",       price: 150, emoji: "&#127851;", veg: true },
      { id: "gulabjamun",  name: "Gulab Jamun",         desc: "Warm, syrup-soaked, two pieces",        price: 90,  emoji: "&#127856;", veg: true }
    ]
  },
  cold: {
    name: "Coolers",
    icon: "&#127865;",
    items: [
      { id: "lime",        name: "Fresh Lime Soda",     desc: "Sweet, salted or mixed",                price: 90,  emoji: "&#127865;", veg: true },
      { id: "juice",       name: "Mixed Fruit Juice",   desc: "Seasonal fruits, no added sugar",       price: 110, emoji: "&#127865;", veg: true },
      { id: "smoothie",    name: "Mango Smoothie",      desc: "Thick & creamy alphonso",               price: 160, emoji: "&#129383;", veg: true },
      { id: "icedlatte",   name: "Iced Latte",          desc: "Double espresso over milk & ice",       price: 170, emoji: "&#129346;", veg: true },
      { id: "water",       name: "Mineral Water",       desc: "500 ml bottle",                         price: 20,  emoji: "&#128167;", veg: true }
    ]
  }
};
