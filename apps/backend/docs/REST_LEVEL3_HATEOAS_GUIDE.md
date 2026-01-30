    response = client.get('/api/categories/1')
    assert response.status_code == 200

    links = response.json()['links']
    assert any(l['rel'] == 'self' for l in links)
    assert any(l['rel'] == 'update' for l in links)
    assert any(l['rel'] == 'delete' for l in links)
    assert any(l['rel'] == 'list' for l in links)

    # Verify all links are valid
    for link in links:
        assert 'href' in link
        assert 'method' in link
        assert link['method'] in ['GET', 'POST', 'PATCH', 'DELETE']

```

## Next Steps

1. **Implement root endpoint** in `main.py`
2. **Add OPTIONS methods** to all route files
3. **Update transaction endpoints** with HATEOAS links
4. **Update recipient endpoints** with HATEOAS links
5. **Update statistics endpoints** with HATEOAS links
6. **Update import endpoints** with HATEOAS links
7. **Test discoverability** by starting from root and following links
