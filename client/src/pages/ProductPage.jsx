import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { useCart } from '../state.jsx';
import { useToast } from '../components/Toast.jsx';
import ProductArt from '../components/ProductArt.jsx';
import QuantityStepper from '../components/QuantityStepper.jsx';
import { ArrowLeftIcon, DatabaseIcon, ReturnIcon, TruckIcon } from '../components/Icons.jsx';
import { StockBadge } from './ShopPage.jsx';

export default function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { add, items } = useCart();
  const toast = useToast();
  const [product, setProduct] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);

  useEffect(() => {
    setProduct(null);
    setQty(1);
    api.product(id).then(p => {
      setProduct(p);
      api.products().then(all => setRelated(all.filter(x => x.category === p.category && x.id !== p.id).slice(0, 3)));
    }).catch(e => setError(e.message));
  }, [id]);

  if (error) return <div className="container"><div className="empty">{error} <Link to="/">Back to the shop</Link></div></div>;
  if (!product) return <div className="container"><div className="product-detail skeleton" /></div>;

  const inCart = items.find(i => i.product.id === product.id)?.quantity || 0;
  const available = Math.max(0, product.stock - inCart);

  const addToCart = goToCart => {
    add(product, qty);
    toast(`${qty} × ${product.name} added to your cart`, 'success');
    setQty(1);
    if (goToCart) navigate('/cart');
  };

  return (
    <div className="container">
      <Link to="/" className="back-link"><ArrowLeftIcon /> Back to the shop</Link>
      <div className="product-detail">
        <ProductArt product={product} size="large" />
        <div className="detail-info">
          <span className="category-label">{product.category}</span>
          <h1>{product.name}</h1>
          <div className="detail-meta">
            <span className="sku">Article {product.productId}</span>
            <StockBadge stock={product.stock} />
            {product.stock > 0 && <span className="muted small">{product.stock} available</span>}
          </div>
          <p className="detail-price">{money(product.price, product.currency)}<small> incl. VAT</small></p>
          <p className="detail-desc">{product.description || 'No description available.'}</p>

          <div className="buy-box">
            <QuantityStepper value={qty} onChange={setQty} max={Math.max(1, available)} disabled={available === 0} />
            <button className="primary large grow" disabled={available === 0} onClick={() => addToCart(false)}>
              {product.stock === 0 ? 'Sold out' : available === 0 ? 'All available items are in your cart' : 'Add to cart'}
            </button>
            <button className="large" disabled={available === 0} onClick={() => addToCart(true)}>Buy now</button>
          </div>
          {inCart > 0 && <p className="muted small">{inCart} already in your <Link to="/cart">cart</Link>.</p>}

          <ul className="detail-perks">
            <li><TruckIcon /> Free shipping, delivered in 1–3 business days</li>
            <li><ReturnIcon /> 30-day returns</li>
            {product.erpManaged && (
              <li><DatabaseIcon /> {product.erpSource === 'file' ? 'Price and stock from the SAP ERP (file transfer)' : 'Price and stock are live from the SAP ERP'}</li>
            )}
          </ul>
        </div>
      </div>

      {related.length > 0 && (
        <section className="related">
          <h2>More in {product.category}</h2>
          <div className="related-grid">
            {related.map(r => (
              <Link key={r.id} to={`/products/${r.id}`} className="related-card">
                <ProductArt product={r} size="small" />
                <span><strong>{r.name}</strong><span className="muted small">{money(r.price, r.currency)}</span></span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
